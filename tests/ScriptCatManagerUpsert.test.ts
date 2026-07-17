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
const GET_ACTION = 'serviceWorker/script/fetchInfo';
const INSTALL_ACTION = 'serviceWorker/script/installByCode';
const SET_CHECK_UPDATE_ACTION = 'serviceWorker/script/setCheckUpdateUrl';
const SCRIPT_ID = '600c047d-0780-506e-b10d-e2860ed3d3d4';
const SOURCE = '// ==UserScript==\n// @name Managed\n// ==/UserScript==\n';

interface RuntimeMessage {
  action: string;
  data: unknown;
}

interface ScriptRecord {
  uuid: string;
  name: string;
  namespace: string;
  status: number;
  type: number;
  metadata: Record<string, string[]>;
  createtime: number;
}

function response(data: unknown): {code: number; data: unknown} {
  return {code: 0, data};
}

function installChromeApi(
  handler: (message: RuntimeMessage) => unknown,
): () => void {
  const priorChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      runtime: {
        sendMessage: (
          message: RuntimeMessage,
          callback: (result: unknown) => void,
        ): void => callback(handler(message)),
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

function offscreenTarget(page: Page): Target {
  return {
    type: () => 'other',
    url: () => `chrome-extension://${EXTENSION_ID}/src/offscreen.html`,
    page: async () => page,
    asPage: async () => page,
  } as unknown as Target;
}

describe('ScriptCatManager upsert', () => {
  it('requires update checks to be disabled and recovers by retrying', async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'scriptcat-manager-upsert-'),
    );
    const extensionPath = path.join(tempRoot, 'extension');
    const repositoryRoot = path.join(tempRoot, 'repository');
    const scriptPath = path.join(repositoryRoot, 'managed.user.js');
    await Promise.all([fs.mkdir(extensionPath), fs.mkdir(repositoryRoot)]);
    await Promise.all([
      fs.writeFile(
        path.join(extensionPath, 'manifest.json'),
        JSON.stringify({version: 'test'}),
      ),
      fs.writeFile(scriptPath, SOURCE),
    ]);

    const record: ScriptRecord = {
      uuid: SCRIPT_ID,
      name: 'Managed',
      namespace: 'test',
      status: 1,
      type: 1,
      metadata: {},
      createtime: 1,
    };
    const receivedMessages: RuntimeMessage[] = [];
    let installed = false;
    let rejectUpdateSetting = true;
    const restoreChrome = installChromeApi(message => {
      receivedMessages.push(message);
      if (message.action === GET_ACTION) {
        return response(installed ? record : null);
      }
      if (message.action === INSTALL_ACTION) {
        installed = true;
        return response(record);
      }
      if (message.action === SET_CHECK_UPDATE_ACTION) {
        if (rejectUpdateSetting) {
          return {code: -1, message: 'update setting failed'};
        }
        return response(undefined);
      }
      throw new Error(`Unexpected ScriptCat action: ${message.action}`);
    });
    const page = {
      evaluate: async (
        callback: (payload: unknown) => unknown,
        payload: unknown,
      ): Promise<unknown> => await callback(payload),
    } as unknown as Page;
    const browser = {
      targets: () => [offscreenTarget(page)],
    } as unknown as Browser;

    try {
      const manager = await ScriptCatManager.create(browser, {
        extensionPath,
        extensionId: EXTENSION_ID,
        repositoryRoot,
        timeout: 1_000,
      });

      await assert.rejects(
        manager.upsertScript({filePath: scriptPath, id: SCRIPT_ID}),
        error => {
          assert.ok(error instanceof ManagedMcpError);
          assert.strictEqual(error.code, 'EXTENSION_NOT_READY');
          return true;
        },
      );
      assert.deepStrictEqual(receivedMessages, [
        {action: GET_ACTION, data: SCRIPT_ID},
        {
          action: INSTALL_ACTION,
          data: {uuid: SCRIPT_ID, code: SOURCE, upsertBy: 'vscode'},
        },
        {
          action: SET_CHECK_UPDATE_ACTION,
          data: {uuid: SCRIPT_ID, checkUpdate: false},
        },
      ]);

      receivedMessages.length = 0;
      rejectUpdateSetting = false;
      assert.deepStrictEqual(
        await manager.upsertScript({filePath: scriptPath, id: SCRIPT_ID}),
        {
          id: SCRIPT_ID,
          path: scriptPath,
          enabled: true,
          updated: true,
        },
      );
      assert.deepStrictEqual(receivedMessages, [
        {action: GET_ACTION, data: SCRIPT_ID},
        {
          action: INSTALL_ACTION,
          data: {uuid: SCRIPT_ID, code: SOURCE, upsertBy: 'vscode'},
        },
        {
          action: SET_CHECK_UPDATE_ACTION,
          data: {uuid: SCRIPT_ID, checkUpdate: false},
        },
      ]);
    } finally {
      restoreChrome();
      await fs.rm(tempRoot, {recursive: true, force: true});
    }
  });
});
