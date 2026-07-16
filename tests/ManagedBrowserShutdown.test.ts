/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import type {ChildProcess} from 'node:child_process';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';

import {executablePath} from 'puppeteer';
import sinon from 'sinon';

import {
  closeBrowser,
  closeBrowserWithBackstop,
  ensureBrowserLaunched,
} from '../src/browser.js';
import {
  ManagedMcpError,
  RELEASE_MISMATCH_ERROR_CODE,
} from '../src/ManagedMcpError.js';
import {
  acquireProfileLock,
  PROFILE_LOCK_FILENAME,
  releaseProfileLock,
} from '../src/ProfileLock.js';
import {puppeteer} from '../src/third_party/index.js';

import {createManagedReleaseFixture} from './fixtures/ManagedRelease.js';

const CLOSE_TEST_TIMEOUT_MS = 10_000;
const OWNER_READY_TIMEOUT_MS = 15_000;
const OWNER_FIXTURE = fileURLToPath(
  new URL('./fixtures/ManagedBrowserOwner.js', import.meta.url),
);

async function profileLockIsAvailable(profile: string): Promise<boolean> {
  const child = spawn('flock', [
    '--exclusive',
    '--nonblock',
    path.join(profile, PROFILE_LOCK_FILENAME),
    'true',
  ]);
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => {
      resolve(code === 0);
    });
  });
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>(resolve => {
    child.once('exit', () => {
      resolve();
    });
  });
}

async function waitForOwnerReady(owner: ChildProcess): Promise<number> {
  const stdout = owner.stdout;
  if (!stdout) {
    throw new Error('The managed browser owner has no stdout pipe.');
  }
  return await new Promise((resolve, reject) => {
    let output = '';
    const finish = (error?: Error, browserPid?: number) => {
      clearTimeout(timeout);
      stdout.off('data', onData);
      owner.off('error', onError);
      owner.off('exit', onExit);
      if (error) {
        reject(error);
        return;
      }
      resolve(browserPid!);
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const newline = output.indexOf('\n');
      if (newline === -1) {
        return;
      }
      const browserPid = Number.parseInt(output.slice(0, newline), 10);
      if (!Number.isSafeInteger(browserPid) || browserPid <= 0) {
        finish(new Error('The managed browser owner returned an invalid PID.'));
        return;
      }
      finish(undefined, browserPid);
    };
    const onError = (error: Error) => {
      finish(error);
    };
    const onExit = () => {
      finish(new Error('The managed browser owner exited before startup.'));
    };
    const timeout = setTimeout(() => {
      finish(new Error('Timed out waiting for the managed browser owner.'));
    }, OWNER_READY_TIMEOUT_MS);
    stdout.on('data', onData);
    owner.once('error', onError);
    owner.once('exit', onExit);
  });
}

async function readDirectChildren(pid: number): Promise<number[]> {
  const children = await fs.readFile(
    `/proc/${pid}/task/${pid}/children`,
    'utf8',
  );
  return children
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(childPid => Number.parseInt(childPid, 10));
}

async function readProcessGroupId(pid: number): Promise<number> {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  const commandEnd = stat.lastIndexOf(') ');
  assert.notStrictEqual(commandEnd, -1);
  const fieldsAfterCommand = stat
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/);
  const processGroupId = Number.parseInt(fieldsAfterCommand[2]!, 10);
  assert.ok(Number.isSafeInteger(processGroupId));
  return processGroupId;
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

async function waitForProcessGroupExit(processGroupId: number): Promise<void> {
  const deadline = Date.now() + CLOSE_TEST_TIMEOUT_MS;
  while (processGroupExists(processGroupId)) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for a process group to exit.');
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function waitForTermination(
  terminationRequested: Promise<void>,
): Promise<void> {
  await Promise.race([
    terminationRequested,
    new Promise<void>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error('Timed out waiting for Chrome termination.'));
      }, CLOSE_TEST_TIMEOUT_MS);
    }),
  ]);
}

async function launchManagedBrowser(): Promise<{
  browser: Awaited<ReturnType<typeof ensureBrowserLaunched>>;
  child: ChildProcess;
  options: Parameters<typeof ensureBrowserLaunched>[0];
  profile: string;
}> {
  const profile = await fs.mkdtemp(
    path.join(os.tmpdir(), 'scriptcat-managed-browser-'),
  );
  const options = {
    headless: true,
    isolated: false,
    userDataDir: profile,
    executablePath: await executablePath(),
    devtools: false,
    profileLock: true,
  };
  const browser = await ensureBrowserLaunched(options);
  const child = browser.process();
  assert.ok(child);
  return {browser, child, options, profile};
}

function delayTermination(child: ChildProcess): {
  terminationRequested: Promise<void>;
  restore(): void;
  terminate(): void;
} {
  const originalKill = child.kill.bind(child);
  let notifyTermination: () => void;
  const terminationRequested = new Promise<void>(resolve => {
    notifyTermination = resolve;
  });
  child.kill = signal => {
    if (signal === 'SIGTERM') {
      notifyTermination();
      return true;
    }
    return originalKill(signal);
  };
  return {
    terminationRequested,
    restore() {
      child.kill = originalKill;
    },
    terminate() {
      originalKill('SIGTERM');
    },
  };
}

function delayEscalation(child: ChildProcess): {
  killRequested: Promise<void>;
  restore(): void;
  signals: Array<NodeJS.Signals | number | undefined>;
  terminate(): void;
} {
  const originalKill = child.kill.bind(child);
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  let notifyKill: () => void;
  const killRequested = new Promise<void>(resolve => {
    notifyKill = resolve;
  });
  child.kill = signal => {
    signals.push(signal);
    if (signal === 'SIGKILL') {
      notifyKill();
    }
    return true;
  };
  return {
    killRequested,
    restore() {
      child.kill = originalKill;
    },
    signals,
    terminate() {
      originalKill('SIGKILL');
    },
  };
}

async function cleanupManagedBrowser(
  children: Array<ChildProcess | null | undefined>,
  profile: string,
): Promise<void> {
  await closeBrowser();
  for (const child of children) {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForExit(child);
    }
  }
  await fs.rm(profile, {recursive: true, force: true});
}

describe('managed browser shutdown', () => {
  it('releases the profile lock without launching Chrome on a release mismatch', async () => {
    const fixture = await createManagedReleaseFixture();
    const profile = await fs.mkdtemp(
      path.join(os.tmpdir(), 'scriptcat-release-mismatch-profile-'),
    );
    const launch = sinon.stub(puppeteer, 'launch');
    try {
      await assert.rejects(
        ensureBrowserLaunched({
          headless: true,
          isolated: false,
          userDataDir: profile,
          executablePath: fixture.releaseB.browserExecutablePath,
          devtools: false,
          profileLock: true,
          managedReleaseConsistency: {
            ...fixture.releaseA,
            browserExecutablePath: fixture.releaseB.browserExecutablePath,
          },
        }),
        error => {
          assert.ok(error instanceof ManagedMcpError);
          assert.strictEqual(error.code, RELEASE_MISMATCH_ERROR_CODE);
          return true;
        },
      );
      sinon.assert.notCalled(launch);
      assert.strictEqual(await profileLockIsAvailable(profile), true);
    } finally {
      launch.restore();
      await fixture.cleanup();
      await fs.rm(profile, {recursive: true, force: true});
    }
  });

  it('keeps the profile owned after SIGKILL until Chrome is reaped without orphans', async () => {
    const profile = await fs.mkdtemp(
      path.join(os.tmpdir(), 'scriptcat-abrupt-browser-owner-'),
    );
    const contender = {};
    const owner = spawn(
      process.execPath,
      [OWNER_FIXTURE, profile, await executablePath()],
      {stdio: ['pipe', 'pipe', 'pipe']},
    );
    let browserProcessGroupId: number | undefined;
    let guardianProcessGroupId: number | undefined;
    try {
      const browserPid = await waitForOwnerReady(owner);
      const guardianPids = (await readDirectChildren(owner.pid!)).filter(
        childPid => childPid !== browserPid,
      );
      assert.strictEqual(guardianPids.length, 1);
      const guardianPid = guardianPids[0]!;
      browserProcessGroupId = await readProcessGroupId(browserPid);
      guardianProcessGroupId = await readProcessGroupId(guardianPid);
      assert.strictEqual(browserProcessGroupId, browserPid);
      assert.strictEqual(guardianProcessGroupId, guardianPid);

      process.kill(-browserProcessGroupId, 'SIGSTOP');
      owner.kill('SIGKILL');
      await waitForExit(owner);
      assert.strictEqual(processGroupExists(browserProcessGroupId), true);
      await assert.rejects(acquireProfileLock(profile, contender), error => {
        assert.ok(error instanceof ManagedMcpError);
        assert.strictEqual(error.code, 'PROFILE_BUSY');
        return true;
      });

      process.kill(-browserProcessGroupId, 'SIGCONT');
      await waitForProcessGroupExit(browserProcessGroupId);
      await waitForProcessGroupExit(guardianProcessGroupId);
      await acquireProfileLock(profile, contender);
      await releaseProfileLock(contender);
      assert.strictEqual(processGroupExists(browserProcessGroupId), false);
      assert.strictEqual(processGroupExists(guardianProcessGroupId), false);
    } finally {
      await releaseProfileLock(contender);
      if (owner.exitCode === null && owner.signalCode === null) {
        owner.kill('SIGKILL');
        await waitForExit(owner);
      }
      if (
        browserProcessGroupId !== undefined &&
        processGroupExists(browserProcessGroupId)
      ) {
        process.kill(-browserProcessGroupId, 'SIGCONT');
        process.kill(-browserProcessGroupId, 'SIGKILL');
        await waitForProcessGroupExit(browserProcessGroupId);
      }
      if (
        guardianProcessGroupId !== undefined &&
        processGroupExists(guardianProcessGroupId)
      ) {
        process.kill(-guardianProcessGroupId, 'SIGKILL');
        await waitForProcessGroupExit(guardianProcessGroupId);
      }
      await fs.rm(profile, {recursive: true, force: true});
    }
  });

  it('reaps a disconnected Chrome before relaunching with the same profile', async () => {
    const {browser, child, options, profile} = await launchManagedBrowser();
    const termination = delayTermination(child);
    let relaunchedChild: ChildProcess | null | undefined;
    try {
      browser.disconnect();
      let relaunchSettled = false;
      const relaunching = ensureBrowserLaunched(options);
      void relaunching.then(
        () => {
          relaunchSettled = true;
        },
        () => {
          relaunchSettled = true;
        },
      );
      await waitForTermination(termination.terminationRequested);
      assert.strictEqual(relaunchSettled, false);
      assert.strictEqual(await profileLockIsAvailable(profile), false);
      termination.restore();
      termination.terminate();
      await waitForExit(child);
      assert.ok(child.exitCode !== null || child.signalCode !== null);
      const relaunched = await relaunching;
      relaunchedChild = relaunched.process();
      assert.ok(relaunchedChild);
      assert.notStrictEqual(relaunchedChild.pid, child.pid);
      assert.strictEqual(await profileLockIsAvailable(profile), false);
      await closeBrowser();
      await waitForExit(relaunchedChild);
      assert.strictEqual(await profileLockIsAvailable(profile), true);
    } finally {
      termination.restore();
      termination.terminate();
      await cleanupManagedBrowser([child, relaunchedChild], profile);
    }
  });

  it('reaps Chrome after a close failure before releasing its profile lock', async () => {
    const {browser, child, profile} = await launchManagedBrowser();
    const termination = delayTermination(child);
    const close = browser.close.bind(browser);
    browser.close = async () => {
      throw new Error('Test browser close failure.');
    };
    try {
      const closing = closeBrowser();
      await waitForTermination(termination.terminationRequested);
      assert.strictEqual(await profileLockIsAvailable(profile), false);
      termination.restore();
      termination.terminate();
      await closing;
      await waitForExit(child);
      assert.ok(child.exitCode !== null || child.signalCode !== null);
      assert.strictEqual(await profileLockIsAvailable(profile), true);
    } finally {
      browser.close = close;
      termination.restore();
      await cleanupManagedBrowser([child], profile);
    }
  });

  it('escalates a hung CDP close without letting the shutdown backstop release the profile', async () => {
    const {browser, child, profile} = await launchManagedBrowser();
    const escalation = delayEscalation(child);
    const close = browser.close.bind(browser);
    const closePending = Promise.withResolvers<void>();
    browser.close = async () => await closePending.promise;
    const backstopReached = Promise.withResolvers<void>();
    let shutdownSettled = false;
    try {
      const closing = closeBrowserWithBackstop(backstopReached.resolve, 50);
      void closing.finally(() => {
        shutdownSettled = true;
      });
      await waitForTermination(backstopReached.promise);
      assert.strictEqual(shutdownSettled, false);
      assert.strictEqual(await profileLockIsAvailable(profile), false);
      assert.strictEqual(child.exitCode, null);
      assert.strictEqual(child.signalCode, null);

      await waitForTermination(escalation.killRequested);
      assert.deepStrictEqual(escalation.signals, ['SIGTERM', 'SIGKILL']);
      assert.strictEqual(shutdownSettled, false);
      assert.strictEqual(await profileLockIsAvailable(profile), false);

      escalation.restore();
      escalation.terminate();
      await closing;
      assert.strictEqual(child.signalCode, 'SIGKILL');
      assert.strictEqual(await profileLockIsAvailable(profile), true);
    } finally {
      closePending.resolve();
      browser.close = close;
      escalation.restore();
      escalation.terminate();
      await cleanupManagedBrowser([child], profile);
    }
  });
});
