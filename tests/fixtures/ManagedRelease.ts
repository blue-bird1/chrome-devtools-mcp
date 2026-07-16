import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface ManagedReleasePaths {
  root: string;
  mcpEntrypointPath: string;
  browserExecutablePath: string;
  extensionPath: string;
}

export interface ManagedReleaseFixture {
  dataRoot: string;
  releaseA: ManagedReleasePaths;
  releaseB: ManagedReleasePaths;
  cleanup(): Promise<void>;
}

export async function createManagedReleaseFixture(
  currentRelease = 'release-a',
): Promise<ManagedReleaseFixture> {
  const dataRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'scriptcat-managed-release-'),
  );
  const releaseA = await createRelease(dataRoot, 'release-a');
  const releaseB = await createRelease(dataRoot, 'release-b');
  await fs.symlink(
    path.join('releases', currentRelease),
    path.join(dataRoot, 'current'),
  );
  return {
    dataRoot,
    releaseA,
    releaseB,
    cleanup: async () => {
      await fs.rm(dataRoot, {recursive: true, force: true});
    },
  };
}

async function createRelease(
  dataRoot: string,
  releaseId: string,
): Promise<ManagedReleasePaths> {
  const root = path.join(dataRoot, 'releases', releaseId);
  const mcpEntrypointPath = path.join(
    root,
    'mcp',
    'bin',
    'chrome-devtools-mcp.js',
  );
  const browserExecutablePath = path.join(
    root,
    'chromium',
    'chrome-linux',
    'chrome',
  );
  const extensionPath = path.join(root, 'scriptcat');
  await Promise.all([
    fs.mkdir(path.dirname(mcpEntrypointPath), {recursive: true}),
    fs.mkdir(path.dirname(browserExecutablePath), {recursive: true}),
    fs.mkdir(extensionPath, {recursive: true}),
  ]);
  await Promise.all([
    fs.writeFile(mcpEntrypointPath, 'export {};\n'),
    fs.writeFile(browserExecutablePath, ''),
  ]);
  return {
    root,
    mcpEntrypointPath,
    browserExecutablePath,
    extensionPath,
  };
}
