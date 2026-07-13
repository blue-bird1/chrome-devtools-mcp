/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {ManagedMcpError} from '../src/ManagedMcpError.js';
import {ScriptCatManager} from '../src/ScriptCatManager.js';
import type {Browser} from '../src/third_party/index.js';

describe('ScriptCatManager', () => {
  it('rejects a symlink that escapes the configured repository', async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'scriptcat-manager-'),
    );
    const extensionPath = path.join(tempRoot, 'extension');
    const repositoryRoot = path.join(tempRoot, 'repository');
    const outsidePath = path.join(tempRoot, 'outside.user.js');
    const escapedPath = path.join(repositoryRoot, 'escaped.user.js');
    await Promise.all([
      fs.mkdir(extensionPath),
      fs.mkdir(repositoryRoot),
      fs.writeFile(
        outsidePath,
        '// ==UserScript==\n// @name Outside\n// ==/UserScript==\n',
      ),
    ]);
    await fs.symlink(outsidePath, escapedPath);

    try {
      const manager = await ScriptCatManager.create({} as Browser, {
        extensionPath,
        extensionId: 'ckchkcgpbkhleahkgkbiiikpcjdbopje',
        repositoryRoot,
        timeout: 1_000,
      });
      await assert.rejects(
        manager.upsertScript({filePath: escapedPath}),
        error => {
          assert.ok(error instanceof ManagedMcpError);
          assert.strictEqual(error.code, 'INVALID_USERSCRIPT');
          return true;
        },
      );
    } finally {
      await fs.rm(tempRoot, {recursive: true, force: true});
    }
  });
});
