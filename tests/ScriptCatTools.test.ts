/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import type {McpContext} from '../src/McpContext.js';
import {zod} from '../src/third_party/index.js';
import {
  scriptCatDeleteScript,
  scriptCatGetScript,
  scriptCatSetEnabled,
  scriptCatUpsertScript,
} from '../src/tools/scriptcat.js';
import type {Response} from '../src/tools/ToolDefinition.js';

const LEGACY_SCRIPT_ID = 'zlib-ui-enhance-local-debug';
const SCRIPT_PATH = '/repository/zlib.user.js';
const WHITESPACE_SCRIPT_ID = ' \t\n ';
const OVERLONG_SCRIPT_ID = 'x'.repeat(513);

function parseParams<Schema extends zod.ZodRawShape>(
  schema: Schema,
  params: unknown,
) {
  return zod.object(schema).safeParse(params);
}

describe('managed ScriptCat tools', () => {
  it('accepts a legacy script ID through each tool schema and handler', async () => {
    const calls: unknown[][] = [];
    const context = {
      scriptCatGetScript: async (id: string) => {
        calls.push(['get', id]);
        return {id};
      },
      scriptCatUpsertScript: async (options: {
        filePath: string;
        id?: string;
        enabled?: boolean;
      }) => {
        calls.push(['upsert', options]);
        return {
          id: options.id ?? LEGACY_SCRIPT_ID,
          path: options.filePath,
          enabled: options.enabled ?? true,
          updated: true,
        };
      },
      scriptCatDeleteScript: async (id: string) => {
        calls.push(['delete', id]);
        return {id, deleted: true as const};
      },
      scriptCatSetEnabled: async (id: string, enabled: boolean) => {
        calls.push(['set-enabled', id, enabled]);
        return {id, enabled};
      },
    } as unknown as McpContext;
    const response = {
      appendResponseLine(value: string) {
        void value;
      },
    } as Response;

    const getParams = parseParams(scriptCatGetScript.schema, {
      id: LEGACY_SCRIPT_ID,
    });
    const upsertParams = parseParams(scriptCatUpsertScript.schema, {
      path: SCRIPT_PATH,
      id: LEGACY_SCRIPT_ID,
      enabled: false,
    });
    const deleteParams = parseParams(scriptCatDeleteScript.schema, {
      id: LEGACY_SCRIPT_ID,
    });
    const setEnabledParams = parseParams(scriptCatSetEnabled.schema, {
      id: LEGACY_SCRIPT_ID,
      enabled: false,
    });

    assert.ok(getParams.success);
    assert.ok(upsertParams.success);
    assert.ok(deleteParams.success);
    assert.ok(setEnabledParams.success);

    await scriptCatGetScript.handler(
      {params: getParams.data},
      response,
      context,
    );
    await scriptCatUpsertScript.handler(
      {params: upsertParams.data},
      response,
      context,
    );
    await scriptCatDeleteScript.handler(
      {params: deleteParams.data},
      response,
      context,
    );
    await scriptCatSetEnabled.handler(
      {params: setEnabledParams.data},
      response,
      context,
    );

    assert.deepStrictEqual(calls, [
      ['get', LEGACY_SCRIPT_ID],
      [
        'upsert',
        {
          filePath: SCRIPT_PATH,
          id: LEGACY_SCRIPT_ID,
          enabled: false,
        },
      ],
      ['delete', LEGACY_SCRIPT_ID],
      ['set-enabled', LEGACY_SCRIPT_ID, false],
    ]);
  });

  it('rejects blank and overlong script IDs for every affected schema', () => {
    const schemas = [
      scriptCatGetScript.schema,
      scriptCatUpsertScript.schema,
      scriptCatDeleteScript.schema,
      scriptCatSetEnabled.schema,
    ];

    for (const schema of schemas) {
      assert.strictEqual(
        schema.id.safeParse(WHITESPACE_SCRIPT_ID).success,
        false,
      );
      assert.strictEqual(
        schema.id.safeParse(OVERLONG_SCRIPT_ID).success,
        false,
      );
    }
  });
});
