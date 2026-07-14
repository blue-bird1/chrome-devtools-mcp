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
import {describe, it} from 'node:test';

import {executablePath} from 'puppeteer';

import {
  closeBrowser,
  closeBrowserWithBackstop,
  ensureBrowserLaunched,
} from '../src/browser.js';
import {PROFILE_LOCK_FILENAME} from '../src/ProfileLock.js';

const CLOSE_TEST_TIMEOUT_MS = 10_000;

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
