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

import sinon from 'sinon';

import {ManagedMcpError} from '../src/ManagedMcpError.js';
import {ScriptCatManager} from '../src/ScriptCatManager.js';
import {Browser, Page, Target, TargetType} from '../src/third_party/index.js';

const EXTENSION_ID = 'ckchkcgpbkhleahkgkbiiikpcjdbopje';
const GET_ACTION = 'serviceWorker/script/fetchInfo';
const INSTALL_ACTION = 'serviceWorker/script/installByCode';
const SET_CHECK_UPDATE_ACTION = 'serviceWorker/script/setCheckUpdateUrl';
const SCRIPT_ID = '600c047d-0780-506e-b10d-e2860ed3d3d4';
const SOURCE = '// ==UserScript==\n// @name Managed\n// ==/UserScript==\n';

interface RuntimeMessage extends Record<string, unknown> {
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
    const handleMessage = (message: RuntimeMessage): unknown => {
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
    };
    const page: Page = Object.create(Page.prototype);
    sinon.stub(page, 'evaluate').callsFake(async (_pageFunction, payload) => {
      if (!isRuntimeMessage(payload)) {
        throw new Error('ScriptCat transport payload is invalid.');
      }
      return {response: handleMessage(payload)};
    });
    const target: Target = Object.create(Target.prototype);
    Object.defineProperties(target, {
      type: {
        value: sinon.stub<[], TargetType>().returns(TargetType.OTHER),
      },
      url: {
        value: sinon
          .stub<[], string>()
          .returns(`chrome-extension://${EXTENSION_ID}/src/offscreen.html`),
      },
      page: {
        value: sinon.stub<[], Promise<Page | null>>().resolves(page),
      },
      asPage: {
        value: sinon.stub<[], Promise<Page>>().resolves(page),
      },
    });
    const browser: Browser = Object.create(Browser.prototype);
    Object.defineProperty(browser, 'targets', {
      value: sinon.stub<[], Target[]>().returns([target]),
    });

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
      await fs.rm(tempRoot, {recursive: true, force: true});
    }
  });
});

function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (
    'action' in value && typeof value.action === 'string' && 'data' in value
  );
}
