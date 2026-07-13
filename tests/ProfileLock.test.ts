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
import {afterEach, describe, it} from 'node:test';

import {ManagedMcpError} from '../src/ManagedMcpError.js';
import {
  acquireProfileLock,
  PROFILE_LOCK_FILENAME,
  releaseProfileLock,
} from '../src/ProfileLock.js';

describe('managed profile lock', () => {
  afterEach(async () => {
    await releaseProfileLock();
  });

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
    try {
      await new Promise<void>((resolve, reject) => {
        holder.once('error', reject);
        holder.stdout.once('data', () => resolve());
      });
      await assert.rejects(acquireProfileLock(profile), error => {
        assert.ok(error instanceof ManagedMcpError);
        assert.strictEqual(error.code, 'PROFILE_BUSY');
        return true;
      });
    } finally {
      holder.stdin.end();
      holder.kill('SIGTERM');
      await fs.rm(profile, {recursive: true, force: true});
    }
  });
});
