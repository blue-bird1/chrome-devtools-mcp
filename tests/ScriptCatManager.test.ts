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
import type {Browser, Page, Target} from '../src/third_party/index.js';

const EXTENSION_ID = 'ckchkcgpbkhleahkgkbiiikpcjdbopje';
const OFFSCREEN_URL = `chrome-extension://${EXTENSION_ID}/src/offscreen.html`;

interface WorkerLike {
  evaluate(callback: () => unknown): Promise<unknown>;
}

function response(data: unknown): {code: number; data: unknown} {
  return {code: 0, data};
}

type RuntimeMessageHandler = (message: unknown) => unknown;

function offscreenTarget(page: Page): Target {
  return {
    type: () => 'other',
    url: () => OFFSCREEN_URL,
    page: async () => page,
    asPage: async () => page,
  } as unknown as Target;
}

function pageTarget(session: {
  send<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}): Target {
  return {
    type: () => 'page',
    url: () => 'about:blank',
    createCDPSession: async () => session,
  } as unknown as Target;
}

function serviceWorkerTarget(worker: WorkerLike): Target {
  return {
    type: () => 'service_worker',
    url: () => `chrome-extension://${EXTENSION_ID}/service-worker.js`,
    worker: async () => worker,
  } as unknown as Target;
}

function installChromeApi(
  handleRuntimeMessage: RuntimeMessageHandler = message =>
    response(
      (message as {action?: unknown}).action === 'serviceWorker/managed/ping'
        ? {managed: true}
        : [],
    ),
): () => void {
  const priorChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      userScripts: {
        getScripts: async (): Promise<unknown[]> => [],
      },
      runtime: {
        sendMessage: (
          message: unknown,
          callback: (result: unknown) => void,
        ): void => {
          callback(handleRuntimeMessage(message));
        },
      },
    },
  });
  return () => {
    if (priorChrome) {
      Object.defineProperty(globalThis, 'chrome', priorChrome);
    } else {
      Reflect.deleteProperty(globalThis, 'chrome');
    }
  };
}

async function createManagerPaths(): Promise<{
  extensionPath: string;
  repositoryRoot: string;
  tempRoot: string;
}> {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'scriptcat-manager-status-'),
  );
  const extensionPath = path.join(tempRoot, 'extension');
  const repositoryRoot = path.join(tempRoot, 'repository');
  await Promise.all([fs.mkdir(extensionPath), fs.mkdir(repositoryRoot)]);
  await fs.writeFile(
    path.join(extensionPath, 'manifest.json'),
    JSON.stringify({version: '1.3.2'}),
  );
  return {extensionPath, repositoryRoot, tempRoot};
}

function healthyPage(): Page {
  return {
    evaluate: async (
      callback: (payload: unknown) => unknown,
      payload: unknown,
    ): Promise<unknown> => await callback(payload),
  } as unknown as Page;
}

function readyWorker(): WorkerLike {
  return {
    evaluate: async (callback: () => unknown): Promise<unknown> =>
      await callback(),
  };
}

function readyExtension(worker: WorkerLike) {
  return async () =>
    new Map([
      [
        EXTENSION_ID,
        {
          enabled: true,
          workers: async () => [worker],
        },
      ],
    ]);
}

describe('ScriptCatManager', () => {
  it('rejects a symlink that escapes the configured repository', async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'scriptcat-manager-'),
    );
    const extensionPath = path.join(tempRoot, 'extension');
    const repositoryRoot = path.join(tempRoot, 'repository');
    const outsidePath = path.join(tempRoot, 'outside.user.js');
    const escapedPath = path.join(repositoryRoot, 'escaped.user.js');
    await Promise.all([fs.mkdir(extensionPath), fs.mkdir(repositoryRoot)]);
    await Promise.all([
      fs.writeFile(
        path.join(extensionPath, 'manifest.json'),
        JSON.stringify({version: '1.3.2'}),
      ),
      fs.writeFile(
        outsidePath,
        '// ==UserScript==\n// @name Outside\n// ==/UserScript==\n',
      ),
    ]);
    await fs.symlink(outsidePath, escapedPath);

    try {
      const manager = await ScriptCatManager.create({} as Browser, {
        extensionPath,
        extensionId: EXTENSION_ID,
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

  it('requires the managed ping action and its exact response payload', async () => {
    const {extensionPath, repositoryRoot, tempRoot} =
      await createManagerPaths();
    const receivedMessages: unknown[] = [];
    let legacyGetAllScriptsProbe = false;
    const restoreChrome = installChromeApi(message => {
      receivedMessages.push(message);
      const action = (message as {action?: unknown}).action;
      if (action === 'serviceWorker/script/getAllScripts') {
        legacyGetAllScriptsProbe = true;
        return response([]);
      }
      if (action === 'serviceWorker/managed/ping') {
        return response({managed: true});
      }
      return response({managed: false});
    });
    const worker = readyWorker();
    const browser = {
      extensions: readyExtension(worker),
      targets: () => [
        serviceWorkerTarget(worker),
        offscreenTarget(healthyPage()),
      ],
    } as Browser;

    try {
      const manager = await ScriptCatManager.create(browser, {
        extensionPath,
        extensionId: EXTENSION_ID,
        repositoryRoot,
        timeout: 1_000,
      });
      const status = await manager.status();
      assert.deepStrictEqual(status, {
        ready: true,
        extension: {
          id: EXTENSION_ID,
          name: undefined,
          version: undefined,
          enabled: true,
          path: undefined,
        },
        serviceWorkerReady: true,
        userScriptsAccessEnabled: true,
        backendTransportReady: true,
        repositoryRoot,
      });
      assert.strictEqual(legacyGetAllScriptsProbe, false);
      assert.deepStrictEqual(receivedMessages, [
        {action: 'serviceWorker/managed/ping', data: undefined},
      ]);
    } finally {
      restoreChrome();
      await fs.rm(tempRoot, {recursive: true, force: true});
    }
  });

  it('rejects malformed and failed managed ping responses', async () => {
    const {extensionPath, repositoryRoot, tempRoot} =
      await createManagerPaths();
    let probeResponse: unknown = response({managed: true});
    const restoreChrome = installChromeApi(() => probeResponse);
    const worker = readyWorker();
    const browser = {
      extensions: readyExtension(worker),
      targets: () => [
        serviceWorkerTarget(worker),
        offscreenTarget(healthyPage()),
      ],
    } as Browser;

    try {
      const manager = await ScriptCatManager.create(browser, {
        extensionPath,
        extensionId: EXTENSION_ID,
        repositoryRoot,
        timeout: 1_000,
      });
      assert.strictEqual((await manager.status()).ready, true);

      probeResponse = response({managed: false});
      const malformed = await manager.status();
      assert.strictEqual(malformed.backendTransportReady, false);
      assert.strictEqual(malformed.ready, false);

      probeResponse = {code: -1, message: 'managed backend unavailable'};
      const failed = await manager.status();
      assert.strictEqual(failed.backendTransportReady, false);
      assert.strictEqual(failed.ready, false);
    } finally {
      restoreChrome();
      await fs.rm(tempRoot, {recursive: true, force: true});
    }
  });

  it('only reports ready while the service worker can use userScripts', async () => {
    const {extensionPath, repositoryRoot, tempRoot} =
      await createManagerPaths();

    const restoreChrome = installChromeApi();
    const worker = readyWorker();
    const page = healthyPage();
    const browser = {
      extensions: readyExtension(worker),
      targets: () => [serviceWorkerTarget(worker), offscreenTarget(page)],
    } as Browser;

    try {
      const manager = await ScriptCatManager.create(browser, {
        extensionPath,
        extensionId: EXTENSION_ID,
        repositoryRoot,
        timeout: 1_000,
      });
      const available = await manager.status();
      assert.strictEqual(available.userScriptsAccessEnabled, true);
      assert.strictEqual(available.ready, true);

      (
        globalThis as unknown as {
          chrome: {userScripts: {getScripts: () => Promise<unknown>}};
        }
      ).chrome.userScripts.getScripts = async () => {
        throw new Error('userScripts access disabled');
      };
      const unavailable = await manager.status();
      assert.strictEqual(unavailable.userScriptsAccessEnabled, false);
      assert.strictEqual(unavailable.ready, false);
    } finally {
      restoreChrome();
      await fs.rm(tempRoot, {recursive: true, force: true});
    }
  });

  it('initializes the managed extension without redundant mutations and propagates load errors', async () => {
    const {extensionPath, repositoryRoot, tempRoot} =
      await createManagerPaths();
    const worker = readyWorker();
    const expectedExtension = {
      id: EXTENSION_ID,
      path: extensionPath,
      version: '1.3.2',
      enabled: true,
    };
    const mutations: Array<{method: string; params?: Record<string, unknown>}> =
      [];
    let extensions = [expectedExtension];
    let userScriptsAccess = true;
    let loadError: Error | undefined;
    const restoreChrome = installChromeApi();
    (
      globalThis as unknown as {
        chrome: {userScripts: {getScripts: () => Promise<unknown>}};
      }
    ).chrome.userScripts.getScripts = async () => {
      if (!userScriptsAccess) {
        throw new Error('userScripts access disabled');
      }
      return [];
    };
    const browser = {
      _connection: {
        send: async <T>(
          method: string,
          params?: Record<string, unknown>,
        ): Promise<T> => {
          if (method === 'Extensions.getExtensions') {
            return {extensions} as T;
          }
          mutations.push({method, params});
          if (method === 'Extensions.loadUnpacked') {
            if (loadError) {
              throw loadError;
            }
            extensions = [expectedExtension];
            userScriptsAccess = true;
            return {id: EXTENSION_ID} as T;
          }
          if (method === 'Extensions.setUserScriptsAccess') {
            userScriptsAccess = params?.enabled === true;
            return undefined as T;
          }
          throw new Error(`Unexpected CDP method: ${method}`);
        },
      },
      extensions: readyExtension(worker),
      targets: () => [
        serviceWorkerTarget(worker),
        offscreenTarget(healthyPage()),
      ],
    } as unknown as Browser;

    try {
      const manager = await ScriptCatManager.create(browser, {
        extensionPath,
        extensionId: EXTENSION_ID,
        repositoryRoot,
        timeout: 1_000,
      });
      await manager.initialize();
      assert.deepStrictEqual(mutations, []);

      extensions = [];
      const missingManager = await ScriptCatManager.create(browser, {
        extensionPath,
        extensionId: EXTENSION_ID,
        repositoryRoot,
        timeout: 1_000,
      });
      await missingManager.initialize();
      assert.deepStrictEqual(mutations, [
        {
          method: 'Extensions.loadUnpacked',
          params: {
            path: extensionPath,
            expectedId: EXTENSION_ID,
            userScriptsAccess: true,
          },
        },
      ]);

      mutations.length = 0;
      userScriptsAccess = false;
      const accessManager = await ScriptCatManager.create(browser, {
        extensionPath,
        extensionId: EXTENSION_ID,
        repositoryRoot,
        timeout: 1_000,
      });
      await accessManager.initialize();
      assert.deepStrictEqual(mutations, [
        {
          method: 'Extensions.setUserScriptsAccess',
          params: {id: EXTENSION_ID, enabled: true},
        },
      ]);

      mutations.length = 0;
      extensions = [{...expectedExtension, enabled: false}];
      const disabledManager = await ScriptCatManager.create(browser, {
        extensionPath,
        extensionId: EXTENSION_ID,
        repositoryRoot,
        timeout: 1_000,
      });
      await assert.rejects(disabledManager.initialize(), error => {
        assert.ok(error instanceof ManagedMcpError);
        assert.strictEqual(error.code, 'EXTENSION_NOT_READY');
        return true;
      });
      assert.deepStrictEqual(mutations, []);

      for (const invalidExtensions of [
        [{...expectedExtension, id: 'unexpected-extension-id'}],
        [{...expectedExtension, path: path.join(extensionPath, 'unexpected')}],
        [{...expectedExtension, version: '1.3.3'}],
        [
          expectedExtension,
          {...expectedExtension, id: 'duplicate-extension-id'},
        ],
      ]) {
        mutations.length = 0;
        extensions = invalidExtensions;
        const invalidManager = await ScriptCatManager.create(browser, {
          extensionPath,
          extensionId: EXTENSION_ID,
          repositoryRoot,
          timeout: 1_000,
        });
        await assert.rejects(invalidManager.initialize(), error => {
          assert.ok(error instanceof ManagedMcpError);
          assert.strictEqual(error.code, 'EXTENSION_NOT_READY');
          return true;
        });
        assert.deepStrictEqual(mutations, []);
      }

      const protocolError = new Error('load unpacked failed');
      extensions = [];
      loadError = protocolError;
      const failedManager = await ScriptCatManager.create(browser, {
        extensionPath,
        extensionId: EXTENSION_ID,
        repositoryRoot,
        timeout: 1_000,
      });
      await assert.rejects(failedManager.initialize(), error => {
        assert.strictEqual(error, protocolError);
        return true;
      });
    } finally {
      restoreChrome();
      await fs.rm(tempRoot, {recursive: true, force: true});
    }
  });

  it('wakes a restored service worker once without changing managed installation counters', async () => {
    const {extensionPath, repositoryRoot, tempRoot} =
      await createManagerPaths();
    const restoreChrome = installChromeApi();
    const worker = readyWorker();
    const extension = {
      id: EXTENSION_ID,
      path: extensionPath,
      version: '1.3.2',
      enabled: true,
    };
    let workerStarted = false;
    const rootRequests: Array<{
      method: string;
      params?: Record<string, unknown>;
    }> = [];
    const pageRequests: Array<{
      method: string;
      params?: Record<string, unknown>;
    }> = [];
    const session = {
      send: async <T>(
        method: string,
        params?: Record<string, unknown>,
      ): Promise<T> => {
        pageRequests.push({method, params});
        if (method === 'ServiceWorker.enable') {
          return undefined as T;
        }
        if (method === 'ServiceWorker.startWorker') {
          workerStarted = true;
          return undefined as T;
        }
        throw new Error(`Unexpected page CDP method: ${method}`);
      },
    };
    const browser = {
      _connection: {
        send: async <T>(
          method: string,
          params?: Record<string, unknown>,
        ): Promise<T> => {
          if (method === 'Extensions.getExtensions') {
            return {extensions: [extension]} as T;
          }
          rootRequests.push({method, params});
          throw new Error(`Unexpected root CDP method: ${method}`);
        },
      },
      extensions: async () =>
        new Map([
          [
            EXTENSION_ID,
            {
              enabled: true,
              workers: async () => (workerStarted ? [worker] : []),
            },
          ],
        ]),
      targets: () => [
        ...(workerStarted ? [serviceWorkerTarget(worker)] : []),
        pageTarget(session),
        offscreenTarget(healthyPage()),
      ],
    } as unknown as Browser;

    try {
      const manager = await ScriptCatManager.create(browser, {
        extensionPath,
        extensionId: EXTENSION_ID,
        repositoryRoot,
        timeout: 1_000,
      });
      await manager.initialize();

      assert.deepStrictEqual(rootRequests, []);
      assert.deepStrictEqual(pageRequests, [
        {
          method: 'ServiceWorker.enable',
          params: undefined,
        },
        {
          method: 'ServiceWorker.startWorker',
          params: {scopeURL: `chrome-extension://${EXTENSION_ID}/`},
        },
      ]);
      assert.strictEqual((await manager.status()).ready, true);
    } finally {
      restoreChrome();
      await fs.rm(tempRoot, {recursive: true, force: true});
    }
  });

  it('does not start a worker that is already ready after a fresh extension load', async () => {
    const {extensionPath, repositoryRoot, tempRoot} =
      await createManagerPaths();
    const restoreChrome = installChromeApi();
    const worker = readyWorker();
    const rootRequests: Array<{
      method: string;
      params?: Record<string, unknown>;
    }> = [];
    const browser = {
      _connection: {
        send: async <T>(
          method: string,
          params?: Record<string, unknown>,
        ): Promise<T> => {
          if (method === 'Extensions.getExtensions') {
            return {
              extensions: [
                {
                  id: EXTENSION_ID,
                  path: extensionPath,
                  version: '1.3.2',
                  enabled: true,
                },
              ],
            } as T;
          }
          rootRequests.push({method, params});
          throw new Error(`Unexpected root CDP method: ${method}`);
        },
      },
      extensions: readyExtension(worker),
      targets: () => [
        serviceWorkerTarget(worker),
        pageTarget({
          send: async <T>(): Promise<T> => {
            throw new Error('A ready worker must not start a CDP session.');
          },
        }),
        offscreenTarget(healthyPage()),
      ],
    } as unknown as Browser;

    try {
      const manager = await ScriptCatManager.create(browser, {
        extensionPath,
        extensionId: EXTENSION_ID,
        repositoryRoot,
        timeout: 1_000,
      });
      await manager.initialize();
      assert.deepStrictEqual(rootRequests, []);
    } finally {
      restoreChrome();
      await fs.rm(tempRoot, {recursive: true, force: true});
    }
  });

  it('reports unsupported worker startup without reloading a restored extension', async () => {
    const {extensionPath, repositoryRoot, tempRoot} =
      await createManagerPaths();
    const restoreChrome = installChromeApi();
    const rootRequests: Array<{
      method: string;
      params?: Record<string, unknown>;
    }> = [];
    const pageRequests: Array<{
      method: string;
      params?: Record<string, unknown>;
    }> = [];
    const session = {
      send: async <T>(
        method: string,
        params?: Record<string, unknown>,
      ): Promise<T> => {
        pageRequests.push({method, params});
        if (method === 'ServiceWorker.enable') {
          return undefined as T;
        }
        throw new Error('ServiceWorker.startWorker unavailable');
      },
    };
    const browser = {
      _connection: {
        send: async <T>(
          method: string,
          params?: Record<string, unknown>,
        ): Promise<T> => {
          if (method === 'Extensions.getExtensions') {
            return {
              extensions: [
                {
                  id: EXTENSION_ID,
                  path: extensionPath,
                  version: '1.3.2',
                  enabled: true,
                },
              ],
            } as T;
          }
          rootRequests.push({method, params});
          throw new Error(`Unexpected root CDP method: ${method}`);
        },
      },
      extensions: async () =>
        new Map([
          [
            EXTENSION_ID,
            {
              enabled: true,
              workers: async () => [],
            },
          ],
        ]),
      targets: () => [pageTarget(session), offscreenTarget(healthyPage())],
    } as unknown as Browser;

    try {
      const manager = await ScriptCatManager.create(browser, {
        extensionPath,
        extensionId: EXTENSION_ID,
        repositoryRoot,
        timeout: 1_000,
      });
      await assert.rejects(manager.initialize(), error => {
        assert.ok(error instanceof ManagedMcpError);
        assert.strictEqual(error.code, 'BROWSER_UNSUPPORTED');
        return true;
      });
      assert.deepStrictEqual(rootRequests, []);
      assert.deepStrictEqual(pageRequests, [
        {
          method: 'ServiceWorker.enable',
          params: undefined,
        },
        {
          method: 'ServiceWorker.startWorker',
          params: {scopeURL: `chrome-extension://${EXTENSION_ID}/`},
        },
      ]);
    } finally {
      restoreChrome();
      await fs.rm(tempRoot, {recursive: true, force: true});
    }
  });

  it('requires an existing page target before waking a restored worker', async () => {
    const {extensionPath, repositoryRoot, tempRoot} =
      await createManagerPaths();
    const restoreChrome = installChromeApi();
    const rootRequests: Array<{
      method: string;
      params?: Record<string, unknown>;
    }> = [];
    const browser = {
      _connection: {
        send: async <T>(
          method: string,
          params?: Record<string, unknown>,
        ): Promise<T> => {
          if (method === 'Extensions.getExtensions') {
            return {
              extensions: [
                {
                  id: EXTENSION_ID,
                  path: extensionPath,
                  version: '1.3.2',
                  enabled: true,
                },
              ],
            } as T;
          }
          rootRequests.push({method, params});
          throw new Error(`Unexpected root CDP method: ${method}`);
        },
      },
      extensions: async () =>
        new Map([
          [
            EXTENSION_ID,
            {
              enabled: true,
              workers: async () => [],
            },
          ],
        ]),
      targets: () => [offscreenTarget(healthyPage())],
    } as unknown as Browser;

    try {
      const manager = await ScriptCatManager.create(browser, {
        extensionPath,
        extensionId: EXTENSION_ID,
        repositoryRoot,
        timeout: 1_000,
      });
      await assert.rejects(manager.initialize(), error => {
        assert.ok(error instanceof ManagedMcpError);
        assert.strictEqual(error.code, 'BROWSER_UNSUPPORTED');
        return true;
      });
      assert.deepStrictEqual(rootRequests, []);
    } finally {
      restoreChrome();
      await fs.rm(tempRoot, {recursive: true, force: true});
    }
  });

  it('uses a replacement offscreen target for the readiness round trip', async () => {
    const {extensionPath, repositoryRoot, tempRoot} =
      await createManagerPaths();
    const restoreChrome = installChromeApi();
    const worker = readyWorker();
    const targetClosed = new Error('Target closed');
    let staleCalls = 0;
    let replacementCalls = 0;
    const stalePage = {
      evaluate: async (): Promise<never> => {
        staleCalls += 1;
        throw targetClosed;
      },
    } as unknown as Page;
    const replacementPage = {
      evaluate: async (
        callback: (payload: unknown) => unknown,
        payload: unknown,
      ): Promise<unknown> => {
        replacementCalls += 1;
        return await callback(payload);
      },
    } as unknown as Page;
    const staleTarget = offscreenTarget(stalePage);
    const replacementTarget = offscreenTarget(replacementPage);
    const browser = {
      extensions: readyExtension(worker),
      targets: () => [
        serviceWorkerTarget(worker),
        staleTarget,
        replacementTarget,
      ],
    } as unknown as Browser;

    try {
      const manager = await ScriptCatManager.create(browser, {
        extensionPath,
        extensionId: EXTENSION_ID,
        repositoryRoot,
        timeout: 1_000,
      });
      const status = await manager.status();
      assert.strictEqual(status.backendTransportReady, true);
      assert.strictEqual(status.ready, true);
      assert.strictEqual(staleCalls, 1);
      assert.strictEqual(replacementCalls, 1);
    } finally {
      restoreChrome();
      await fs.rm(tempRoot, {recursive: true, force: true});
    }
  });

  it('retries a list request after the status target closes', async () => {
    const {extensionPath, repositoryRoot, tempRoot} =
      await createManagerPaths();
    const restoreChrome = installChromeApi();
    const worker = readyWorker();
    const targetClosed = new Error('Execution context was destroyed');
    let initialAvailable = true;
    let initialCalls = 0;
    let replacementCalls = 0;
    const initialPage = {
      evaluate: async (
        callback: (payload: unknown) => unknown,
        payload: unknown,
      ): Promise<unknown> => {
        initialCalls += 1;
        if (!initialAvailable) {
          throw targetClosed;
        }
        return await callback(payload);
      },
    } as unknown as Page;
    const replacementPage = {
      evaluate: async (
        callback: (payload: unknown) => unknown,
        payload: unknown,
      ): Promise<unknown> => {
        replacementCalls += 1;
        return await callback(payload);
      },
    } as unknown as Page;
    const initialTarget = offscreenTarget(initialPage);
    const replacementTarget = offscreenTarget(replacementPage);
    const browser = {
      extensions: readyExtension(worker),
      targets: () => [
        serviceWorkerTarget(worker),
        initialTarget,
        replacementTarget,
      ],
    } as unknown as Browser;

    try {
      const manager = await ScriptCatManager.create(browser, {
        extensionPath,
        extensionId: EXTENSION_ID,
        repositoryRoot,
        timeout: 1_000,
      });
      assert.strictEqual((await manager.status()).ready, true);
      initialAvailable = false;
      assert.deepStrictEqual(await manager.listScripts(), []);
      assert.strictEqual(initialCalls, 2);
      assert.strictEqual(replacementCalls, 1);
    } finally {
      restoreChrome();
      await fs.rm(tempRoot, {recursive: true, force: true});
    }
  });
});
