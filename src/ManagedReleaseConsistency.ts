/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  ACTIVATION_INCOMPLETE_ERROR_CODE,
  ManagedMcpError,
  RELEASE_MISMATCH_ERROR_CODE,
} from './ManagedMcpError.js';

const ACTIVATION_JOURNAL_FILENAME = 'activation-journal.json';

export interface ManagedReleaseConsistencyOptions {
  mcpEntrypointPath: string;
  browserExecutablePath: string;
  extensionPath: string;
}

interface CanonicalReleasePath {
  path: string;
  releaseRoot: string;
}

type PhysicalTreeEntry = {type: 'directory'} | {type: 'file'; digest: string};

export async function assertManagedReleaseConsistency(
  options: ManagedReleaseConsistencyOptions,
): Promise<void> {
  try {
    const mcpEntrypoint = await canonicalReleasePath(
      'MCP entrypoint',
      options.mcpEntrypointPath,
    );
    const dataRoot = path.dirname(path.dirname(mcpEntrypoint.releaseRoot));
    await assertActivationComplete(dataRoot);

    const [browserExecutable, current, managedExtension] = await Promise.all([
      canonicalReleasePath('browser executable', options.browserExecutablePath),
      canonicalReleasePath(
        'managed data current link',
        path.join(dataRoot, 'current'),
      ),
      canonicalPhysicalDirectory(
        'managed ScriptCat extension',
        options.extensionPath,
      ),
    ]);
    const expectedReleaseRoot = mcpEntrypoint.releaseRoot;
    if (
      current.path !== current.releaseRoot ||
      browserExecutable.releaseRoot !== expectedReleaseRoot ||
      current.releaseRoot !== expectedReleaseRoot
    ) {
      throw releaseMismatch({
        mcpEntrypoint,
        browserExecutable,
        current,
        managedExtension,
      });
    }

    const releaseExtension = await canonicalPhysicalDirectory(
      'active release ScriptCat extension',
      path.join(current.releaseRoot, 'scriptcat'),
    );
    if (!(await physicalTreesMatch(releaseExtension, managedExtension))) {
      throw releaseMismatch({
        releaseExtension,
        managedExtension,
      });
    }
  } catch (error) {
    if (
      error instanceof ManagedMcpError &&
      (error.code === ACTIVATION_INCOMPLETE_ERROR_CODE ||
        error.code === RELEASE_MISMATCH_ERROR_CODE)
    ) {
      throw error;
    }
    throw releaseMismatch(
      {
        mcpEntrypointPath: options.mcpEntrypointPath,
        browserExecutablePath: options.browserExecutablePath,
        extensionPath: options.extensionPath,
      },
      error,
    );
  }
}

async function assertActivationComplete(dataRoot: string): Promise<void> {
  const journalPath = path.join(dataRoot, ACTIVATION_JOURNAL_FILENAME);
  try {
    await fs.lstat(journalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw activationIncomplete(journalPath, error);
  }
  throw activationIncomplete(journalPath);
}

async function canonicalReleasePath(
  label: string,
  inputPath: string,
): Promise<CanonicalReleasePath> {
  const canonicalPath = await fs.realpath(inputPath);
  let candidate = canonicalPath;
  while (true) {
    const parent = path.dirname(candidate);
    if (path.basename(parent) === 'releases') {
      return {path: canonicalPath, releaseRoot: candidate};
    }
    if (parent === candidate) {
      throw new Error(`${label} is not inside a managed release.`);
    }
    candidate = parent;
  }
}

async function canonicalPhysicalDirectory(
  label: string,
  inputPath: string,
): Promise<string> {
  const resolvedPath = path.resolve(inputPath);
  const [status, canonicalPath] = await Promise.all([
    fs.lstat(inputPath),
    fs.realpath(inputPath),
  ]);
  if (
    inputPath !== resolvedPath ||
    canonicalPath !== resolvedPath ||
    !status.isDirectory()
  ) {
    throw new Error(`${label} is not a canonical physical directory.`);
  }
  return canonicalPath;
}

async function physicalTreesMatch(
  expectedRoot: string,
  actualRoot: string,
): Promise<boolean> {
  const [expected, actual] = await Promise.all([
    inspectPhysicalTree(expectedRoot),
    inspectPhysicalTree(actualRoot),
  ]);
  if (expected.size !== actual.size) {
    return false;
  }
  for (const [relativePath, expectedEntry] of expected) {
    const actualEntry = actual.get(relativePath);
    if (
      actualEntry?.type !== expectedEntry.type ||
      (expectedEntry.type === 'file' &&
        (actualEntry.type !== 'file' ||
          actualEntry.digest !== expectedEntry.digest))
    ) {
      return false;
    }
  }
  return true;
}

async function inspectPhysicalTree(
  root: string,
): Promise<Map<string, PhysicalTreeEntry>> {
  const entries = new Map<string, PhysicalTreeEntry>();
  await walkPhysicalDirectory(root, '', entries);
  return entries;
}

async function walkPhysicalDirectory(
  directory: string,
  relativeDirectory: string,
  entries: Map<string, PhysicalTreeEntry>,
): Promise<void> {
  await canonicalPhysicalDirectory('ScriptCat extension directory', directory);
  const children = await fs.readdir(directory, {withFileTypes: true});
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const childPath = path.join(directory, child.name);
    const relativePath = relativeDirectory
      ? path.join(relativeDirectory, child.name)
      : child.name;
    const status = await fs.lstat(childPath);
    if (status.isDirectory()) {
      entries.set(relativePath, {type: 'directory'});
      await walkPhysicalDirectory(childPath, relativePath, entries);
      continue;
    }
    if (!status.isFile()) {
      throw new Error(
        'ScriptCat extension trees must contain regular files only.',
      );
    }
    entries.set(relativePath, {
      type: 'file',
      digest: await digestPhysicalFile(childPath),
    });
  }
}

async function digestPhysicalFile(filePath: string): Promise<string> {
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const status = await handle.stat();
    if (!status.isFile()) {
      throw new Error(
        'ScriptCat extension trees must contain regular files only.',
      );
    }
    return createHash('sha256')
      .update(await handle.readFile())
      .digest('hex');
  } finally {
    await handle.close();
  }
}

function activationIncomplete(
  journalPath: string,
  cause?: unknown,
): ManagedMcpError {
  return new ManagedMcpError(
    ACTIVATION_INCOMPLETE_ERROR_CODE,
    'Managed MCP activation is incomplete.',
    {journalPath},
    cause === undefined ? undefined : {cause},
  );
}

function releaseMismatch(
  details: Record<string, unknown>,
  cause?: unknown,
): ManagedMcpError {
  return new ManagedMcpError(
    RELEASE_MISMATCH_ERROR_CODE,
    'Managed MCP components do not match the active release.',
    details,
    cause === undefined ? undefined : {cause},
  );
}
