/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import {ManagedMcpError} from './ManagedMcpError.js';

export const PROFILE_LOCK_FILENAME = '.scriptcat-mcp.lock';
const LOCK_READY = 'LOCKED\n';
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RELEASE_TIMEOUT_MS = 2_000;

export type ProfileLockOwner = object;

let lockProcess: ChildProcessWithoutNullStreams | undefined;
let lockOwner: ProfileLockOwner | undefined;
let lockedUserDataDir: string | undefined;
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
  await fs.mkdir(resolvedUserDataDir, {recursive: true});
  const lockPath = path.join(resolvedUserDataDir, PROFILE_LOCK_FILENAME);
  const child = spawn(
    'flock',
    [
      '--exclusive',
      '--nonblock',
      lockPath,
      'sh',
      '-c',
      `printf '${LOCK_READY}'; cat >/dev/null`,
    ],
    {stdio: ['pipe', 'pipe', 'pipe']},
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
