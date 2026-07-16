import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface ManagedReleasePaths {
  root: string;
  mcpEntrypointPath: string;
  browserExecutablePath: string;
  extensionPath: string;
  releaseExtensionPath: string;
}

export interface ManagedReleaseFixture {
  dataRoot: string;
  extensionPath: string;
  releaseA: ManagedReleasePaths;
  releaseB: ManagedReleasePaths;
  cleanup(): Promise<void>;
}

export async function createManagedReleaseFixture(
  currentRelease = 'release-a',
): Promise<ManagedReleaseFixture> {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'scriptcat-managed-release-'),
  );
  const dataRoot = path.join(tempRoot, 'data');
  const extensionPath = path.join(
    tempRoot,
    'chrome-extensions',
    'scriptcat',
    'v1.3.2',
  );
  const releaseA = await createRelease(dataRoot, extensionPath, 'release-a');
  const releaseB = await createRelease(dataRoot, extensionPath, 'release-b');
  const current = currentRelease === 'release-a' ? releaseA : releaseB;
  await Promise.all([
    fs.symlink(
      path.join('releases', currentRelease),
      path.join(dataRoot, 'current'),
    ),
    fs.mkdir(path.dirname(extensionPath), {recursive: true}),
  ]);
  await fs.cp(current.releaseExtensionPath, extensionPath, {recursive: true});
  return {
    dataRoot,
    extensionPath,
    releaseA,
    releaseB,
    cleanup: async () => {
      await fs.rm(tempRoot, {recursive: true, force: true});
    },
  };
}

async function createRelease(
  dataRoot: string,
  extensionPath: string,
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
  const releaseExtensionPath = path.join(root, 'scriptcat');
  const extensionBundlePath = path.join(
    releaseExtensionPath,
    'dist',
    'service-worker.js',
  );
  await Promise.all([
    fs.mkdir(path.dirname(mcpEntrypointPath), {recursive: true}),
    fs.mkdir(path.dirname(browserExecutablePath), {recursive: true}),
    fs.mkdir(path.dirname(extensionBundlePath), {recursive: true}),
    fs.mkdir(path.join(releaseExtensionPath, 'empty'), {recursive: true}),
  ]);
  await Promise.all([
    fs.writeFile(mcpEntrypointPath, 'export {};\n'),
    fs.writeFile(browserExecutablePath, ''),
    fs.writeFile(
      path.join(releaseExtensionPath, 'manifest.json'),
      `${releaseId}\n`,
    ),
    fs.writeFile(extensionBundlePath, `console.log('${releaseId}');\n`),
  ]);
  return {
    root,
    mcpEntrypointPath,
    browserExecutablePath,
    extensionPath,
    releaseExtensionPath,
  };
}
