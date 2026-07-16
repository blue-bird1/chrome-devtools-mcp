/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import {describe, it} from 'node:test';

import {
  ACTIVATION_INCOMPLETE_ERROR_CODE,
  ManagedMcpError,
  RELEASE_MISMATCH_ERROR_CODE,
} from '../src/ManagedMcpError.js';
import {assertManagedReleaseConsistency} from '../src/ManagedReleaseConsistency.js';

import {createManagedReleaseFixture} from './fixtures/ManagedRelease.js';
import type {
  ManagedReleaseFixture,
  ManagedReleasePaths,
} from './fixtures/ManagedRelease.js';

const ACTIVATION_JOURNAL_FILENAME = 'activation-journal.json';
const EXTENSION_MANIFEST_FILENAME = 'manifest.json';
const EXTENSION_EXTRA_FILENAME = 'extra.js';
const EXTENSION_BUNDLE_PATH = path.join('dist', 'service-worker.js');

async function assertGateError(
  operation: Promise<void>,
  expectedCode:
    | typeof ACTIVATION_INCOMPLETE_ERROR_CODE
    | typeof RELEASE_MISMATCH_ERROR_CODE,
): Promise<void> {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof ManagedMcpError);
    assert.strictEqual(error.code, expectedCode);
    return true;
  });
}

describe('managed release consistency', () => {
  it('accepts a physical extension matching the canonical current release', async () => {
    const fixture = await createManagedReleaseFixture();
    try {
      await assertManagedReleaseConsistency(fixture.releaseA);
    } finally {
      await fixture.cleanup();
    }
  });

  const mismatchCases = [
    {
      name: 'MCP entrypoint',
      currentRelease: 'release-a',
      paths: (
        releaseA: ManagedReleasePaths,
        releaseB: ManagedReleasePaths,
      ) => ({
        ...releaseA,
        mcpEntrypointPath: releaseB.mcpEntrypointPath,
      }),
    },
    {
      name: 'browser executable',
      currentRelease: 'release-a',
      paths: (
        releaseA: ManagedReleasePaths,
        releaseB: ManagedReleasePaths,
      ) => ({
        ...releaseA,
        browserExecutablePath: releaseB.browserExecutablePath,
      }),
    },
    {
      name: 'current release',
      currentRelease: 'release-b',
      paths: (releaseA: ManagedReleasePaths) => releaseA,
    },
  ];

  for (const mismatchCase of mismatchCases) {
    it(`rejects a mismatched ${mismatchCase.name}`, async () => {
      const fixture = await createManagedReleaseFixture(
        mismatchCase.currentRelease,
      );
      try {
        await assertGateError(
          assertManagedReleaseConsistency(
            mismatchCase.paths(fixture.releaseA, fixture.releaseB),
          ),
          RELEASE_MISMATCH_ERROR_CODE,
        );
      } finally {
        await fixture.cleanup();
      }
    });
  }

  it('rejects startup while an activation journal exists', async () => {
    const fixture = await createManagedReleaseFixture();
    try {
      await fs.writeFile(
        path.join(fixture.dataRoot, ACTIVATION_JOURNAL_FILENAME),
        '{}\n',
      );
      await assertGateError(
        assertManagedReleaseConsistency(fixture.releaseA),
        ACTIVATION_INCOMPLETE_ERROR_CODE,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  const treeMismatchCases = [
    {
      name: 'modified file content',
      mutate: async (fixture: ManagedReleaseFixture) => {
        await fs.writeFile(
          path.join(fixture.extensionPath, EXTENSION_MANIFEST_FILENAME),
          'changed\n',
        );
      },
    },
    {
      name: 'an extra file',
      mutate: async (fixture: ManagedReleaseFixture) => {
        await fs.writeFile(
          path.join(fixture.extensionPath, EXTENSION_EXTRA_FILENAME),
          'export {};\n',
        );
      },
    },
    {
      name: 'a missing file',
      mutate: async (fixture: ManagedReleaseFixture) => {
        await fs.unlink(
          path.join(fixture.extensionPath, EXTENSION_MANIFEST_FILENAME),
        );
      },
    },
  ];

  for (const mismatchCase of treeMismatchCases) {
    it(`rejects a managed extension with ${mismatchCase.name}`, async () => {
      const fixture = await createManagedReleaseFixture();
      try {
        await mismatchCase.mutate(fixture);
        await assertGateError(
          assertManagedReleaseConsistency(fixture.releaseA),
          RELEASE_MISMATCH_ERROR_CODE,
        );
      } finally {
        await fixture.cleanup();
      }
    });
  }

  it('rejects a symlinked managed extension directory', async () => {
    const fixture = await createManagedReleaseFixture();
    try {
      await fs.rm(fixture.extensionPath, {recursive: true});
      await fs.symlink(
        fixture.releaseA.releaseExtensionPath,
        fixture.extensionPath,
        'dir',
      );
      await assertGateError(
        assertManagedReleaseConsistency(fixture.releaseA),
        RELEASE_MISMATCH_ERROR_CODE,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects symlinks inside the managed extension tree', async () => {
    const fixture = await createManagedReleaseFixture();
    const managedBundle = path.join(
      fixture.extensionPath,
      EXTENSION_BUNDLE_PATH,
    );
    try {
      await fs.unlink(managedBundle);
      await fs.symlink(
        path.join(fixture.releaseA.releaseExtensionPath, EXTENSION_BUNDLE_PATH),
        managedBundle,
      );
      await assertGateError(
        assertManagedReleaseConsistency(fixture.releaseA),
        RELEASE_MISMATCH_ERROR_CODE,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
