/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {ManagedMcpError} from '../src/ManagedMcpError.js';
import {
  acquireProfileLock,
  PROFILE_LOCK_FILENAME,
  releaseProfileLock,
} from '../src/ProfileLock.js';

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

describe('managed profile lock', () => {
  it('reports PROFILE_BUSY while another process owns the profile', async () => {
    const profile = await fs.mkdtemp(
      path.join(os.tmpdir(), 'scriptcat-profile-lock-'),
    );
    const lockPath = path.join(profile, PROFILE_LOCK_FILENAME);
    const holder = spawn(
      'flock',
      [
        '--exclusive',
        lockPath,
        'sh',
        '-c',
        "printf 'LOCKED\\n'; cat >/dev/null",
      ],
      {stdio: ['pipe', 'pipe', 'pipe']},
    );
    const owner = {};
    try {
      await new Promise<void>((resolve, reject) => {
        holder.once('error', reject);
        holder.stdout.once('data', () => resolve());
      });
      await assert.rejects(acquireProfileLock(profile, owner), error => {
        assert.ok(error instanceof ManagedMcpError);
        assert.strictEqual(error.code, 'PROFILE_BUSY');
        return true;
      });
    } finally {
      await releaseProfileLock(owner);
      holder.stdin.end();
      holder.kill('SIGTERM');
      await fs.rm(profile, {recursive: true, force: true});
    }
  });

  it('only allows the owning browser lifecycle to reuse or release the lock', async () => {
    const profile = await fs.mkdtemp(
      path.join(os.tmpdir(), 'scriptcat-profile-owner-'),
    );
    const owner = {};
    const otherOwner = {};
    try {
      await acquireProfileLock(profile, owner);
      await acquireProfileLock(profile, owner);
      await assert.rejects(acquireProfileLock(profile, otherOwner), error => {
        assert.ok(error instanceof ManagedMcpError);
        assert.strictEqual(error.code, 'PROFILE_BUSY');
        return true;
      });
      await releaseProfileLock(otherOwner);
      assert.strictEqual(await profileLockIsAvailable(profile), false);
      await releaseProfileLock(owner);
      assert.strictEqual(await profileLockIsAvailable(profile), true);
    } finally {
      await releaseProfileLock(owner);
      await fs.rm(profile, {recursive: true, force: true});
    }
  });
});
