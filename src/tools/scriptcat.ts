/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';

const managedScriptCatCondition = ['managedScriptcatPath'];
const SCRIPT_ID_MAX_LENGTH = 512;
const idSchema = zod
  .string()
  .max(SCRIPT_ID_MAX_LENGTH)
  .refine(value => value.trim().length > 0, {
    message: 'ScriptCat script ID must not be blank.',
  })
  .describe('Non-empty ScriptCat script ID.');

function appendJson(
  response: {appendResponseLine(value: string): void},
  data: unknown,
) {
  response.appendResponseLine(JSON.stringify(data, null, 2));
}

export const scriptCatStatus = defineTool({
  name: 'scriptcat_status',
  description: 'Reports readiness of the managed ScriptCat backend.',
  annotations: {
    category: ToolCategory.EXTENSIONS,
    readOnlyHint: true,
    conditions: managedScriptCatCondition,
  },
  schema: {},
  blockedByDialog: false,
  verifyFilesSchema: [],
  handler: async (_request, response, context) => {
    appendJson(response, await context.scriptCatStatus());
  },
});

export const scriptCatListScripts = defineTool({
  name: 'scriptcat_list_scripts',
  description: 'Lists scripts stored in the managed ScriptCat profile.',
  annotations: {
    category: ToolCategory.EXTENSIONS,
    readOnlyHint: true,
    conditions: managedScriptCatCondition,
  },
  schema: {
    enabled: zod
      .boolean()
      .optional()
      .describe('If provided, only return scripts with this enabled state.'),
  },
  blockedByDialog: false,
  verifyFilesSchema: [],
  handler: async (request, response, context) => {
    appendJson(
      response,
      await context.scriptCatListScripts(request.params.enabled),
    );
  },
});

export const scriptCatGetScript = defineTool({
  name: 'scriptcat_get_script',
  description: 'Returns ScriptCat metadata and the raw userscript source.',
  annotations: {
    category: ToolCategory.EXTENSIONS,
    readOnlyHint: true,
    conditions: managedScriptCatCondition,
  },
  schema: {id: idSchema},
  blockedByDialog: false,
  verifyFilesSchema: [],
  handler: async (request, response, context) => {
    appendJson(response, await context.scriptCatGetScript(request.params.id));
  },
});

export const scriptCatUpsertScript = defineTool({
  name: 'scriptcat_upsert_script',
  description:
    'Installs or updates a repository userscript in the managed ScriptCat profile.',
  annotations: {
    category: ToolCategory.EXTENSIONS,
    readOnlyHint: false,
    conditions: managedScriptCatCondition,
  },
  schema: {
    path: zod
      .string()
      .describe('Path to a *.user.js file inside the configured repository.'),
    id: idSchema.optional(),
    enabled: zod.boolean().optional(),
  },
  blockedByDialog: false,
  verifyFilesSchema: ['path'],
  handler: async (request, response, context) => {
    appendJson(
      response,
      await context.scriptCatUpsertScript({
        filePath: request.params.path,
        id: request.params.id,
        enabled: request.params.enabled,
      }),
    );
  },
});

export const scriptCatDeleteScript = defineTool({
  name: 'scriptcat_delete_script',
  description: 'Deletes a script from the managed ScriptCat profile.',
  annotations: {
    category: ToolCategory.EXTENSIONS,
    readOnlyHint: false,
    conditions: managedScriptCatCondition,
  },
  schema: {id: idSchema},
  blockedByDialog: false,
  verifyFilesSchema: [],
  handler: async (request, response, context) => {
    appendJson(
      response,
      await context.scriptCatDeleteScript(request.params.id),
    );
  },
});

export const scriptCatSetEnabled = defineTool({
  name: 'scriptcat_set_enabled',
  description: 'Enables or disables a script in the managed ScriptCat profile.',
  annotations: {
    category: ToolCategory.EXTENSIONS,
    readOnlyHint: false,
    conditions: managedScriptCatCondition,
  },
  schema: {id: idSchema, enabled: zod.boolean()},
  blockedByDialog: false,
  verifyFilesSchema: [],
  handler: async (request, response, context) => {
    appendJson(
      response,
      await context.scriptCatSetEnabled(
        request.params.id,
        request.params.enabled,
      ),
    );
  },
});
