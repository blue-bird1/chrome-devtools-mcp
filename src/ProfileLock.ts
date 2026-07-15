/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import {ManagedMcpError} from './ManagedMcpError.js';

export const PROFILE_LOCK_FILENAME = '.scriptcat-mcp.lock';
const LOCK_READY = 'LOCKED\n';
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RELEASE_TIMEOUT_MS = 2_000;
const PROFILE_LOCK_GUARDIAN = [
  "browser_pid=''",
  "browser_start_time=''",
  "control_pid=''",
  'owner_closed=0',
  'read_start_time() {',
  '  stat_line=$(cat "/proc/$browser_pid/stat" 2>/dev/null) || return 1',
  '  stat_line=${stat_line##*) }',
  '  set -- $stat_line',
  '  [ "$#" -ge 20 ] || return 1',
  '  shift 19',
  '  printf \'%s\\n\' "$1"',
  '}',
  'browser_process_alive() {',
  '  [ "$(read_start_time)" = "$browser_start_time" ]',
  '}',
  'browser_group_alive() {',
  '  kill -0 -- "-$browser_pid" 2>/dev/null',
  '}',
  'managed_browser_alive() {',
  '  browser_process_alive || browser_group_alive',
  '}',
  'stop_control_reader() {',
  '  if [ -n "$control_pid" ]; then',
  '    kill "$control_pid" 2>/dev/null || true',
  '    wait "$control_pid" 2>/dev/null || true',
  '    control_pid=',
  '  fi',
  '}',
  "trap 'owner_closed=1' USR1",
  "trap 'exit 0' HUP INT TERM",
  "trap 'stop_control_reader' EXIT",
  "printf 'LOCKED\\n'",
  "IFS=' ' read -r browser_pid browser_start_time || exit 0",
  '(cat >/dev/null && kill -USR1 "$$") &',
  'control_pid=$!',
  'while managed_browser_alive && [ "$owner_closed" -eq 0 ]; do',
  '  sleep 0.05',
  'done',
  'if managed_browser_alive; then',
  '  kill -TERM -- "-$browser_pid" 2>/dev/null || true',
  '  attempts=0',
  '  while managed_browser_alive && [ "$attempts" -lt 40 ]; do',
  '    sleep 0.05',
  '    attempts=$((attempts + 1))',
  '  done',
  '  if managed_browser_alive; then',
  '    kill -KILL -- "-$browser_pid" 2>/dev/null || true',
  '  fi',
  'fi',
  'while managed_browser_alive; do',
  '  sleep 0.05',
  'done',
].join('\n');

export type ProfileLockOwner = object;

let lockProcess: ChildProcessWithoutNullStreams | undefined;
let lockOwner: ProfileLockOwner | undefined;
let lockedUserDataDir: string | undefined;
let lockedBrowserPid: number | undefined;
let lockReleasePromise: Promise<void> | undefined;

export async function acquireProfileLock(
  userDataDir: string,
  owner: ProfileLockOwner,
): Promise<void> {
  if (lockReleasePromise) {
    await lockReleasePromise;
  }
  const resolvedUserDataDir = path.resolve(userDataDir);
  if (lockProcess && !isProcessExited(lockProcess)) {
    if (lockOwner === owner && lockedUserDataDir === resolvedUserDataDir) {
      return;
    }
    throw new ManagedMcpError(
      'PROFILE_BUSY',
      'The managed ScriptCat profile is already owned by another browser lifecycle.',
      {userDataDir: resolvedUserDataDir},
    );
  }

  lockProcess = undefined;
  lockOwner = undefined;
  lockedUserDataDir = undefined;
  lockedBrowserPid = undefined;
  await fs.mkdir(resolvedUserDataDir, {recursive: true});
  const lockPath = path.join(resolvedUserDataDir, PROFILE_LOCK_FILENAME);
  const child = spawn(
    'flock',
    [
      '--exclusive',
      '--nonblock',
      '--no-fork',
      lockPath,
      'sh',
      '-c',
      PROFILE_LOCK_GUARDIAN,
    ],
    {detached: true, stdio: ['pipe', 'pipe', 'pipe']},
  );

  try {
    await waitForLock(child, resolvedUserDataDir);
    lockProcess = child;
    lockOwner = owner;
    lockedUserDataDir = resolvedUserDataDir;
  } catch (error) {
    child.stdin.destroy();
    if (!isProcessExited(child)) {
      child.kill('SIGTERM');
    }
    throw error;
  }
}

export async function bindProfileLockToBrowser(
  owner: ProfileLockOwner,
  browserProcess: ChildProcess,
): Promise<void> {
  const guardian = lockProcess;
  if (
    !guardian ||
    isProcessExited(guardian) ||
    lockOwner !== owner ||
    !lockedUserDataDir
  ) {
    throw new Error('The managed profile lock is not owned by this browser.');
  }
  const browserPid = browserProcess.pid;
  if (!browserPid) {
    throw new Error('The launched browser does not expose its process ID.');
  }
  if (lockedBrowserPid !== undefined) {
    if (lockedBrowserPid === browserPid) {
      return;
    }
    throw new Error('The managed profile lock is already bound to a browser.');
  }

  const browserStartTime = await readProcessStartTime(browserPid);
  if (lockProcess !== guardian || isProcessExited(guardian)) {
    throw new Error('The managed profile lock guardian exited during launch.');
  }
  await new Promise<void>((resolve, reject) => {
    guardian.stdin.write(`${browserPid} ${browserStartTime}\n`, error => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  lockedBrowserPid = browserPid;
}

async function readProcessStartTime(pid: number): Promise<string> {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  const commandEnd = stat.lastIndexOf(') ');
  if (commandEnd === -1) {
    throw new Error(`Could not read the launched browser process ${pid}.`);
  }
  const fieldsAfterCommand = stat
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/);
  const startTime = fieldsAfterCommand[19];
  if (!startTime) {
    throw new Error(`Could not read the launched browser process ${pid}.`);
  }
  return startTime;
}

async function waitForLock(
  child: ChildProcessWithoutNullStreams,
  userDataDir: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes(LOCK_READY)) {
        finish();
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    };
    const onError = (error: Error) => {
      finish(
        new ManagedMcpError(
          'BROWSER_UNSUPPORTED',
          'The system flock utility is required for the managed profile.',
          {userDataDir},
          {cause: error},
        ),
      );
    };
    const onExit = (code: number | null) => {
      finish(
        new ManagedMcpError(
          'PROFILE_BUSY',
          'The managed ScriptCat profile is already owned by another process.',
          {userDataDir, lockExitCode: code, stderr: stderr.trim() || undefined},
        ),
      );
    };
    const timeout = setTimeout(() => {
      finish(
        new ManagedMcpError(
          'TIMEOUT',
          'Timed out while acquiring the managed ScriptCat profile lock.',
          {userDataDir},
        ),
      );
    }, LOCK_TIMEOUT_MS);

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

export async function releaseProfileLock(
  owner: ProfileLockOwner,
): Promise<void> {
  if (lockReleasePromise) {
    if (lockOwner === owner) {
      await lockReleasePromise;
    }
    return;
  }
  const child = lockProcess;
  if (!child || isProcessExited(child)) {
    lockProcess = undefined;
    lockOwner = undefined;
    lockedUserDataDir = undefined;
    lockedBrowserPid = undefined;
    return;
  }
  if (lockOwner !== owner) {
    return;
  }

  const releasePromise = closeLockProcess(child);
  lockReleasePromise = releasePromise;
  try {
    await releasePromise;
  } finally {
    if (lockProcess === child && isProcessExited(child)) {
      lockProcess = undefined;
      lockOwner = undefined;
      lockedUserDataDir = undefined;
      lockedBrowserPid = undefined;
    }
    if (lockReleasePromise === releasePromise) {
      lockReleasePromise = undefined;
    }
  }
}

async function closeLockProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  child.stdin.end();
  if (await waitForExit(child, LOCK_RELEASE_TIMEOUT_MS)) {
    return;
  }
  child.kill('SIGTERM');
  if (await waitForExit(child, LOCK_RELEASE_TIMEOUT_MS)) {
    return;
  }
  child.kill('SIGKILL');
  await waitForExit(child);
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeout?: number,
): Promise<boolean> {
  if (isProcessExited(child)) {
    return true;
  }
  return await new Promise(resolve => {
    let timeoutId: NodeJS.Timeout | undefined;
    const finish = (exited: boolean) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => {
      finish(true);
    };
    child.once('exit', onExit);
    if (isProcessExited(child)) {
      finish(true);
      return;
    }
    if (timeout !== undefined) {
      timeoutId = setTimeout(() => {
        finish(false);
      }, timeout);
    }
  });
}

function isProcessExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
