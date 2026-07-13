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

let lockProcess: ChildProcessWithoutNullStreams | undefined;

export async function acquireProfileLock(userDataDir: string): Promise<void> {
  if (lockProcess && lockProcess.exitCode === null) {
    return;
  }

  await fs.mkdir(userDataDir, {recursive: true});
  const lockPath = path.join(userDataDir, PROFILE_LOCK_FILENAME);
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
    await waitForLock(child, userDataDir);
    lockProcess = child;
  } catch (error) {
    child.stdin.destroy();
    child.kill('SIGTERM');
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

export async function releaseProfileLock(): Promise<void> {
  const child = lockProcess;
  lockProcess = undefined;
  if (!child || child.exitCode !== null) {
    return;
  }

  child.stdin.end();
  await new Promise<void>(resolve => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      resolve();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
