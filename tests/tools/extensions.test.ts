/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import sinon from 'sinon';

import type {ParsedArguments} from '../../src/bin/chrome-devtools-mcp-cli-options.js';
import {
  MANAGED_EXTENSION_PROTECTED_ERROR_CODE,
  ManagedMcpError,
} from '../../src/ManagedMcpError.js';
import type {McpContext} from '../../src/McpContext.js';
import {zod} from '../../src/third_party/index.js';
import {listConsoleMessages} from '../../src/tools/console.js';
import {
  installExtension,
  uninstallExtension,
  listExtensions,
  reloadExtension,
  setExtensionUserScriptsAccess,
  triggerExtensionAction,
} from '../../src/tools/extensions.js';
import {serverHooks} from '../server.js';
import {
  assertNoServiceWorkerReported,
  extractExtensionId,
  withMcpContext,
  html,
  getTextContent,
} from '../utils.js';

const EXTENSION_WITH_SW_PATH = path.join(
  import.meta.dirname,
  '../../../tests/tools/fixtures/extension-sw',
);
const EXTENSION_PATH = path.join(
  import.meta.dirname,
  '../../../tests/tools/fixtures/extension',
);
const EXTENSION_CONTENT_SCRIPT_PATH = path.join(
  import.meta.dirname,
  '../../../tests/tools/fixtures/extension-content-script',
);
const MANAGED_EXTENSION_ID = 'ckchkcgpbkhleahkgkbiiikpcjdbopje';
const SET_USER_SCRIPTS_ACCESS_METHOD = 'Extensions.setUserScriptsAccess';

function parseParams<Schema extends zod.ZodRawShape>(
  schema: Schema,
  params: unknown,
) {
  return zod.object(schema).parse(params);
}

async function assertManagedExtensionProtected(
  callback: () => Promise<unknown>,
): Promise<void> {
  await assert.rejects(callback, error => {
    assert.ok(error instanceof ManagedMcpError);
    assert.strictEqual(error.code, MANAGED_EXTENSION_PROTECTED_ERROR_CODE);
    assert.strictEqual(
      (JSON.parse(error.message) as {code: unknown}).code,
      MANAGED_EXTENSION_PROTECTED_ERROR_CODE,
    );
    return true;
  });
}

function stubSetUserScriptsAccess(context: McpContext) {
  const connection = (
    context.browser as unknown as {
      _connection: {
        send(
          method: string,
          params?: Record<string, unknown>,
        ): Promise<unknown>;
      };
    }
  )._connection;
  const originalSend = connection.send.bind(connection);
  return sinon
    .stub(connection, 'send')
    .callsFake(async (method, params): Promise<unknown> => {
      if (method === SET_USER_SCRIPTS_ACCESS_METHOD) {
        return;
      }
      return await originalSend(method, params);
    });
}

describe('extension', () => {
  const server = serverHooks();

  afterEach(() => {
    sinon.restore();
  });

  it('installs and uninstalls an extension and verifies it in chrome://extensions', async () => {
    await withMcpContext(async (response, context) => {
      // Install the extension
      await installExtension.handler(
        {params: {path: EXTENSION_PATH}},
        response,
        context,
      );

      const extensionId = extractExtensionId(response);
      const page = context.getSelectedPptrPage();
      await page.goto('chrome://extensions');

      const element = await page.waitForSelector(
        `extensions-manager >>> extensions-item[id="${extensionId}"]`,
      );
      assert.ok(
        element,
        `Extension with ID "${extensionId}" should be visible on chrome://extensions`,
      );

      // Uninstall the extension
      await uninstallExtension.handler(
        {params: {id: extensionId!}},
        response,
        context,
      );

      const uninstallResponseLine = response.responseLines[1];
      assert.ok(
        uninstallResponseLine.includes('Extension uninstalled'),
        'Response should indicate uninstallation',
      );

      await page.waitForSelector('extensions-manager');

      const elementAfterUninstall = await page.$(
        `extensions-manager >>> extensions-item[id="${extensionId}"]`,
      );
      assert.strictEqual(
        elementAfterUninstall,
        null,
        `Extension with ID "${extensionId}" should NOT be visible on chrome://extensions`,
      );
    });
  });
  it('lists installed extensions', async () => {
    await withMcpContext(async (response, context) => {
      const setListExtensionsSpy = sinon.spy(response, 'setListExtensions');
      await listExtensions.handler({params: {}}, response, context);
      assert.ok(
        setListExtensionsSpy.calledOnce,
        'setListExtensions should be called',
      );
    });
  });
  it('reloads an extension', async () => {
    await withMcpContext(
      async (response, context) => {
        await installExtension.handler(
          {params: {path: EXTENSION_PATH}},
          response,
          context,
        );

        const extensionId = extractExtensionId(response);
        const installSpy = sinon.spy(context, 'installExtension');
        response.resetResponseLineForTesting();

        await reloadExtension.handler(
          {params: {id: extensionId!}},
          response,
          context,
        );
        assert.ok(
          installSpy.calledOnceWithExactly(EXTENSION_PATH),
          'installExtension should be called with the extension path',
        );

        const reloadResponseLine = response.responseLines[0];
        assert.ok(
          reloadResponseLine.includes('Extension reloaded'),
          'Response should indicate reload',
        );

        const list = Array.from((await context.listExtensions()).values());

        assert.ok(list.length === 1, 'List should have only one extension');
        const reinstalled = list.find(e => e.id === extensionId);
        assert.ok(reinstalled, 'Extension should be present after reload');
        await context.uninstallExtension(extensionId!);
      },
      {},
      {
        categoryExtensions: true,
      },
    );
  });
  it('allows userScripts access changes outside managed mode', async () => {
    await withMcpContext(async (response, context) => {
      const sendStub = stubSetUserScriptsAccess(context);
      const params = parseParams(setExtensionUserScriptsAccess.schema, {
        id: MANAGED_EXTENSION_ID,
        enabled: false,
      });

      await setExtensionUserScriptsAccess.handler({params}, response, context);

      assert.strictEqual(sendStub.callCount, 1);
      assert.deepStrictEqual(sendStub.firstCall.args, [
        SET_USER_SCRIPTS_ACCESS_METHOD,
        {id: MANAGED_EXTENSION_ID, enabled: false},
      ]);
    });
  });

  it('protects only the managed extension from generic mutation tools', async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'managed-extension-protection-'),
    );
    const managedExtensionAlias = path.join(tempRoot, 'extension-alias');
    await fs.symlink(EXTENSION_PATH, managedExtensionAlias, 'dir');
    try {
      await withMcpContext(
        async (response, context) => {
          const sendStub = stubSetUserScriptsAccess(context);
          const installSpy = sinon.spy(context.browser, 'installExtension');
          const uninstallSpy = sinon.spy(context.browser, 'uninstallExtension');
          const protectedInstallParams = parseParams(installExtension.schema, {
            path: managedExtensionAlias,
          });
          const protectedIdParams = parseParams(uninstallExtension.schema, {
            id: MANAGED_EXTENSION_ID,
          });
          const protectedReloadParams = parseParams(reloadExtension.schema, {
            id: MANAGED_EXTENSION_ID,
          });
          const disableAccessParams = parseParams(
            setExtensionUserScriptsAccess.schema,
            {id: MANAGED_EXTENSION_ID, enabled: false},
          );

          await assertManagedExtensionProtected(() =>
            installExtension.handler(
              {params: protectedInstallParams},
              response,
              context,
            ),
          );
          await assertManagedExtensionProtected(() =>
            uninstallExtension.handler(
              {params: protectedIdParams},
              response,
              context,
            ),
          );
          await assertManagedExtensionProtected(() =>
            reloadExtension.handler(
              {params: protectedReloadParams},
              response,
              context,
            ),
          );
          await assertManagedExtensionProtected(() =>
            setExtensionUserScriptsAccess.handler(
              {params: disableAccessParams},
              response,
              context,
            ),
          );

          assert.strictEqual(installSpy.callCount, 0);
          assert.strictEqual(uninstallSpy.callCount, 0);
          assert.strictEqual(sendStub.callCount, 0);

          const enableAccessParams = parseParams(
            setExtensionUserScriptsAccess.schema,
            {id: MANAGED_EXTENSION_ID, enabled: true},
          );
          await setExtensionUserScriptsAccess.handler(
            {params: enableAccessParams},
            response,
            context,
          );
          await setExtensionUserScriptsAccess.handler(
            {params: enableAccessParams},
            response,
            context,
          );
          await assertManagedExtensionProtected(() =>
            setExtensionUserScriptsAccess.handler(
              {params: disableAccessParams},
              response,
              context,
            ),
          );
          assert.deepStrictEqual(
            sendStub.getCalls().map(call => call.args),
            [
              [
                SET_USER_SCRIPTS_ACCESS_METHOD,
                {id: MANAGED_EXTENSION_ID, enabled: true},
              ],
              [
                SET_USER_SCRIPTS_ACCESS_METHOD,
                {id: MANAGED_EXTENSION_ID, enabled: true},
              ],
            ],
          );

          const otherInstallParams = parseParams(installExtension.schema, {
            path: EXTENSION_WITH_SW_PATH,
          });
          response.resetResponseLineForTesting();
          await installExtension.handler(
            {params: otherInstallParams},
            response,
            context,
          );
          const otherExtensionId = extractExtensionId(response);
          await reloadExtension.handler(
            {
              params: parseParams(reloadExtension.schema, {
                id: otherExtensionId,
              }),
            },
            response,
            context,
          );
          await setExtensionUserScriptsAccess.handler(
            {
              params: parseParams(setExtensionUserScriptsAccess.schema, {
                id: otherExtensionId,
                enabled: false,
              }),
            },
            response,
            context,
          );
          await uninstallExtension.handler(
            {
              params: parseParams(uninstallExtension.schema, {
                id: otherExtensionId,
              }),
            },
            response,
            context,
          );
          assert.strictEqual(installSpy.callCount, 2);
          assert.strictEqual(uninstallSpy.callCount, 1);
          const accessCalls = sendStub
            .getCalls()
            .filter(call => call.args[0] === SET_USER_SCRIPTS_ACCESS_METHOD);
          assert.deepStrictEqual(accessCalls.at(-1)?.args, [
            SET_USER_SCRIPTS_ACCESS_METHOD,
            {id: otherExtensionId, enabled: false},
          ]);
        },
        {
          scriptCat: {
            extensionPath: EXTENSION_PATH,
            extensionId: MANAGED_EXTENSION_ID,
            repositoryRoot: import.meta.dirname,
            timeout: 1_000,
          },
        },
        {categoryExtensions: true},
      );
    } finally {
      await fs.rm(tempRoot, {recursive: true, force: true});
    }
  });
  it('triggers an extension action', async () => {
    await withMcpContext(
      async (response, context) => {
        const extensionId = await context.installExtension(
          EXTENSION_WITH_SW_PATH,
        );

        const targetsBefore = context.browser.targets();
        const pageTargetBefore = targetsBefore.find(
          t => t.type() === 'page' && t.url().includes(extensionId),
        );
        assert.ok(!pageTargetBefore, 'Page should not exist before action');

        await triggerExtensionAction.handler(
          {params: {id: extensionId}},
          response,
          context,
        );

        const pageTargetAfter = await context.browser.waitForTarget(
          t => t.type() === 'page' && t.url().includes(extensionId),
        );
        assert.ok(pageTargetAfter, 'Page should exist after action');
        await context.uninstallExtension(extensionId);
        const targets = context.browser.targets();
        assertNoServiceWorkerReported(targets, extensionId);
      },
      {},
      {
        categoryExtensions: true,
      },
    );
  });

  it('verifies that content script console logs are received', async () => {
    await withMcpContext(
      async (response, context) => {
        server.addHtmlRoute(
          '/test-content-script',
          html`<h1>Test Content Script</h1>`,
        );
        const url = server.getRoute('/test-content-script');

        const extensionId = await context.installExtension(
          EXTENSION_CONTENT_SCRIPT_PATH,
        );

        const mcpPage = context.getSelectedMcpPage();
        const page = mcpPage.pptrPage;

        await page.goto(url);

        await listConsoleMessages({
          categoryExtensions: true,
        } as ParsedArguments).handler(
          {params: {includePreservedMessages: true}, page: mcpPage},
          response,
          context,
        );

        const result = await response.handle('list_console_messages', context);
        const consoleOutput = getTextContent(result.content[0]);
        assert.ok(
          consoleOutput.includes('from content script!'),
          `Console output should contain message from content script. Got: ${consoleOutput}`,
        );

        await context.uninstallExtension(extensionId);
      },
      {},
      {
        categoryExtensions: true,
      },
    );
  });
});
