/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

import {
  MANAGED_EXTENSION_PROTECTED_ERROR_CODE,
  ManagedMcpError,
  RELEASE_MISMATCH_ERROR_CODE,
} from './ManagedMcpError.js';
import {ScriptCatBackend} from './ScriptCatBackend.js';
import type {Browser, Extension} from './third_party/index.js';

const SCRIPT_STATUS_ENABLED = 1;
const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

const ACTIONS = {
  list: 'serviceWorker/script/getAllScripts',
  get: 'serviceWorker/script/fetchInfo',
  getSource: 'serviceWorker/script/getSource',
  upsert: 'serviceWorker/script/installByCode',
  delete: 'serviceWorker/script/deletes',
  setEnabled: 'serviceWorker/script/enable',
} as const;

interface RawCdpBrowser extends Browser {
  _connection?: {
    send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  };
}

interface ScriptCatRecord {
  uuid: string;
  name: string;
  namespace: string;
  status: number;
  type: number;
  metadata: Record<string, string[] | undefined>;
  createtime: number;
  updatetime?: number;
}

export interface ScriptCatStatus {
  ready: boolean;
  extension: {
    id: string;
    name?: string;
    version?: string;
    enabled?: boolean;
    path?: string;
  };
  serviceWorkerReady: boolean;
  userScriptsAccessEnabled: boolean | null;
  backendTransportReady: boolean;
  repositoryRoot: string;
}

export interface ScriptCatScriptSummary {
  id: string;
  name: string;
  namespace: string;
  version?: string;
  enabled: boolean;
  type: number;
  createdAt: number;
  updatedAt?: number;
}

export interface ScriptCatScript extends ScriptCatScriptSummary {
  source: string;
  metadata: Record<string, string[] | undefined>;
}

export interface ScriptCatUpsertResult {
  id: string;
  path: string;
  enabled: boolean;
  updated: boolean;
}

export interface ScriptCatManagerOptions {
  extensionPath: string;
  extensionId: string;
  repositoryRoot: string;
  timeout: number;
}

export interface ManagedReleaseConsistencyOptions {
  mcpEntrypointPath: string;
  browserExecutablePath: string;
  extensionPath: string;
}

interface CanonicalReleasePath {
  path: string;
  releaseRoot: string;
}

export type ManagedExtensionMutation =
  'install' | 'reload' | 'uninstall' | 'disable-user-scripts';

export async function assertManagedReleaseConsistency(
  options: ManagedReleaseConsistencyOptions,
): Promise<void> {
  try {
    const [mcpEntrypoint, browserExecutable, extension] = await Promise.all([
      canonicalReleasePath('MCP entrypoint', options.mcpEntrypointPath),
      canonicalReleasePath('browser executable', options.browserExecutablePath),
      canonicalReleasePath(
        'managed ScriptCat extension',
        options.extensionPath,
      ),
    ]);
    const dataRoot = path.dirname(path.dirname(mcpEntrypoint.releaseRoot));
    const current = await canonicalReleasePath(
      'managed data current link',
      path.join(dataRoot, 'current'),
    );
    const expectedReleaseRoot = mcpEntrypoint.releaseRoot;
    if (
      current.path !== current.releaseRoot ||
      browserExecutable.releaseRoot !== expectedReleaseRoot ||
      extension.releaseRoot !== expectedReleaseRoot ||
      current.releaseRoot !== expectedReleaseRoot
    ) {
      throw releaseMismatch({
        mcpEntrypoint,
        browserExecutable,
        extension,
        current,
      });
    }
  } catch (error) {
    if (
      error instanceof ManagedMcpError &&
      error.code === RELEASE_MISMATCH_ERROR_CODE
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

export async function setExtensionUserScriptsAccess(
  browser: Browser,
  id: string,
  enabled: boolean,
): Promise<void> {
  const connection = (browser as RawCdpBrowser)._connection;
  if (!connection) {
    throw new ManagedMcpError(
      'BROWSER_UNSUPPORTED',
      'The browser does not expose a root CDP connection.',
      {id},
    );
  }
  try {
    await connection.send('Extensions.setUserScriptsAccess', {id, enabled});
  } catch (error) {
    throw new ManagedMcpError(
      'BROWSER_UNSUPPORTED',
      'The browser does not support Extensions.setUserScriptsAccess.',
      {id, enabled},
      {cause: error},
    );
  }
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

function releaseMismatch(
  details: Record<string, unknown>,
  cause?: unknown,
): ManagedMcpError {
  return new ManagedMcpError(
    RELEASE_MISMATCH_ERROR_CODE,
    'Managed MCP components do not resolve to the same active release.',
    details,
    cause === undefined ? undefined : {cause},
  );
}

export class ScriptCatManager {
  readonly #browser: Browser;
  readonly #extensionPath: string;
  readonly #extensionId: string;
  readonly #repositoryRoot: string;
  readonly #timeout: number;
  readonly #backend: ScriptCatBackend;

  private constructor(
    browser: Browser,
    options: ScriptCatManagerOptions,
    extensionPath: string,
    repositoryRoot: string,
  ) {
    this.#browser = browser;
    this.#extensionPath = extensionPath;
    this.#extensionId = options.extensionId;
    this.#repositoryRoot = repositoryRoot;
    this.#timeout = options.timeout;
    this.#backend = new ScriptCatBackend(
      browser,
      options.extensionId,
      options.timeout,
    );
  }

  static async create(
    browser: Browser,
    options: ScriptCatManagerOptions,
  ): Promise<ScriptCatManager> {
    const [extensionPath, repositoryRoot] = await Promise.all([
      canonicalDirectory(options.extensionPath, 'managed ScriptCat extension'),
      canonicalDirectory(options.repositoryRoot, 'ScriptCat repository root'),
    ]);
    return new ScriptCatManager(
      browser,
      options,
      extensionPath,
      repositoryRoot,
    );
  }

  async initialize(): Promise<void> {
    let installedId: string;
    try {
      installedId = await this.#browser.installExtension(this.#extensionPath);
    } catch (error) {
      throw new ManagedMcpError(
        'EXTENSION_NOT_READY',
        'Failed to load the managed ScriptCat extension.',
        {extensionPath: this.#extensionPath},
        {cause: error},
      );
    }
    if (installedId !== this.#extensionId) {
      throw new ManagedMcpError(
        'EXTENSION_NOT_READY',
        'The managed ScriptCat extension ID does not match the pinned ID.',
        {expectedId: this.#extensionId, installedId},
      );
    }

    await setExtensionUserScriptsAccess(this.#browser, this.#extensionId, true);

    const reloadedId = await this.#browser.installExtension(
      this.#extensionPath,
    );
    if (reloadedId !== this.#extensionId) {
      throw new ManagedMcpError(
        'EXTENSION_NOT_READY',
        'Reloading the managed ScriptCat extension changed its ID.',
        {expectedId: this.#extensionId, reloadedId},
      );
    }
    await this.#waitUntilReady();
  }

  async assertExtensionInstallationAllowed(
    extensionPath: string,
  ): Promise<void> {
    let canonicalPath: string;
    try {
      canonicalPath = await fs.realpath(extensionPath);
    } catch {
      return;
    }
    if (canonicalPath === this.#extensionPath) {
      this.#throwProtectedMutation('install');
    }
  }

  assertExtensionMutationAllowed(
    extensionId: string,
    mutation: Exclude<ManagedExtensionMutation, 'install'>,
  ): void {
    if (extensionId === this.#extensionId) {
      this.#throwProtectedMutation(mutation);
    }
  }

  assertUserScriptsAccessChangeAllowed(
    extensionId: string,
    enabled: boolean,
  ): void {
    if (extensionId === this.#extensionId && !enabled) {
      this.#throwProtectedMutation('disable-user-scripts');
    }
  }

  async status(): Promise<ScriptCatStatus> {
    let extension: Extension | undefined;
    try {
      extension = (await this.#browser.extensions()).get(this.#extensionId);
    } catch {
      return {
        ready: false,
        extension: {id: this.#extensionId},
        serviceWorkerReady: false,
        userScriptsAccessEnabled: null,
        backendTransportReady: false,
        repositoryRoot: this.#repositoryRoot,
      };
    }

    let serviceWorkerReady = false;
    if (extension) {
      try {
        serviceWorkerReady = Boolean((await extension.workers()).length);
      } catch {
        serviceWorkerReady = false;
      }
    }
    const userScriptsAccessEnabled =
      await this.#backend.userScriptsAccessEnabled();
    const backendTransportReady = await this.#backend.transportReady();
    return {
      ready: Boolean(
        extension?.enabled &&
        serviceWorkerReady &&
        userScriptsAccessEnabled === true &&
        backendTransportReady,
      ),
      extension: {
        id: this.#extensionId,
        name: extension?.name,
        version: extension?.version,
        enabled: extension?.enabled,
        path: extension?.path,
      },
      serviceWorkerReady,
      userScriptsAccessEnabled,
      backendTransportReady,
      repositoryRoot: this.#repositoryRoot,
    };
  }

  async listScripts(enabled?: boolean): Promise<ScriptCatScriptSummary[]> {
    const records = await this.#backend.send<ScriptCatRecord[]>(ACTIONS.list);
    const summaries = records.map(toSummary);
    return enabled === undefined
      ? summaries
      : summaries.filter(script => script.enabled === enabled);
  }

  async getScript(id: string): Promise<ScriptCatScript> {
    const record = await this.#getRecord(id);
    const source = await this.#backend.send<string | null>(
      ACTIONS.getSource,
      id,
    );
    if (source === null) {
      throw scriptNotFound(id);
    }
    if (typeof source !== 'string') {
      throw new ManagedMcpError(
        'EXTENSION_NOT_READY',
        'ScriptCat returned an invalid source response.',
        {id},
      );
    }
    return {...toSummary(record), source, metadata: record.metadata};
  }

  async upsertScript(options: {
    filePath: string;
    id?: string;
    enabled?: boolean;
  }): Promise<ScriptCatUpsertResult> {
    const sourcePath = await this.#validateUserscriptPath(options.filePath);
    const source = await fs.readFile(sourcePath, 'utf8');
    if (!isUserscriptSource(source)) {
      throw new ManagedMcpError(
        'INVALID_USERSCRIPT',
        'The source does not contain a valid UserScript metadata block.',
        {path: sourcePath},
      );
    }

    const requestedId =
      options.id ?? uuidV5(pathToFileURL(sourcePath).href, URL_NAMESPACE);
    const previous = await this.#backend.send<ScriptCatRecord | null>(
      ACTIONS.get,
      requestedId,
    );

    let installed: ScriptCatRecord;
    try {
      installed = await this.#backend.send<ScriptCatRecord>(
        ACTIONS.upsert,
        {uuid: requestedId, code: source, upsertBy: 'vscode'},
        'INVALID_USERSCRIPT',
      );
    } catch (error) {
      if (error instanceof ManagedMcpError) {
        throw error;
      }
      throw new ManagedMcpError(
        'INVALID_USERSCRIPT',
        'ScriptCat rejected the userscript source.',
        {path: sourcePath, id: requestedId},
        {cause: error},
      );
    }

    if (options.enabled !== undefined) {
      await this.#backend.send(ACTIONS.setEnabled, {
        uuid: installed.uuid,
        enable: options.enabled,
      });
      installed.status = options.enabled ? SCRIPT_STATUS_ENABLED : 2;
    }
    return {
      id: installed.uuid,
      path: sourcePath,
      enabled: installed.status === SCRIPT_STATUS_ENABLED,
      updated: previous !== null || installed.uuid !== requestedId,
    };
  }

  async deleteScript(id: string): Promise<{id: string; deleted: true}> {
    await this.#getRecord(id);
    await this.#backend.send(ACTIONS.delete, [id]);
    return {id, deleted: true};
  }

  async setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<{id: string; enabled: boolean}> {
    await this.#getRecord(id);
    await this.#backend.send(ACTIONS.setEnabled, {uuid: id, enable: enabled});
    return {id, enabled};
  }

  async #getRecord(id: string): Promise<ScriptCatRecord> {
    const record = await this.#backend.send<ScriptCatRecord | null>(
      ACTIONS.get,
      id,
    );
    if (record === null) {
      throw scriptNotFound(id);
    }
    return record;
  }

  async #validateUserscriptPath(filePath: string): Promise<string> {
    let canonicalPath: string;
    try {
      canonicalPath = await fs.realpath(filePath);
    } catch (error) {
      throw new ManagedMcpError(
        'INVALID_USERSCRIPT',
        'The userscript path does not exist.',
        {path: filePath},
        {cause: error},
      );
    }
    const relativePath = path.relative(this.#repositoryRoot, canonicalPath);
    if (
      relativePath === '' ||
      relativePath.startsWith(`..${path.sep}`) ||
      relativePath === '..' ||
      path.isAbsolute(relativePath) ||
      !canonicalPath.endsWith('.user.js')
    ) {
      throw new ManagedMcpError(
        'INVALID_USERSCRIPT',
        'Only *.user.js files inside the configured repository are accepted.',
        {path: canonicalPath, repositoryRoot: this.#repositoryRoot},
      );
    }
    const stat = await fs.stat(canonicalPath);
    if (!stat.isFile()) {
      throw new ManagedMcpError(
        'INVALID_USERSCRIPT',
        'The userscript path is not a regular file.',
        {path: canonicalPath},
      );
    }
    return canonicalPath;
  }

  async #waitUntilReady(): Promise<void> {
    const deadline = Date.now() + this.#timeout;
    let lastStatus: ScriptCatStatus | undefined;
    while (Date.now() < deadline) {
      lastStatus = await this.status();
      if (lastStatus.ready) {
        return;
      }
      await delay(100);
    }
    throw new ManagedMcpError(
      'TIMEOUT',
      'Timed out waiting for the managed ScriptCat service worker.',
      {extensionId: this.#extensionId, lastStatus},
    );
  }

  #throwProtectedMutation(mutation: ManagedExtensionMutation): never {
    throw new ManagedMcpError(
      MANAGED_EXTENSION_PROTECTED_ERROR_CODE,
      'The managed ScriptCat extension cannot be mutated by a generic extension tool.',
      {
        extensionId: this.#extensionId,
        extensionPath: this.#extensionPath,
        mutation,
      },
    );
  }
}

async function canonicalDirectory(
  inputPath: string,
  label: string,
): Promise<string> {
  let canonicalPath: string;
  try {
    canonicalPath = await fs.realpath(inputPath);
  } catch (error) {
    throw new ManagedMcpError(
      'EXTENSION_NOT_READY',
      `The ${label} path does not exist.`,
      {path: inputPath},
      {cause: error},
    );
  }
  if (!(await fs.stat(canonicalPath)).isDirectory()) {
    throw new ManagedMcpError(
      'EXTENSION_NOT_READY',
      `The ${label} path is not a directory.`,
      {path: canonicalPath},
    );
  }
  return canonicalPath;
}

function toSummary(record: ScriptCatRecord): ScriptCatScriptSummary {
  return {
    id: record.uuid,
    name: record.name,
    namespace: record.namespace,
    version: record.metadata.version?.[0],
    enabled: record.status === SCRIPT_STATUS_ENABLED,
    type: record.type,
    createdAt: record.createtime,
    updatedAt: record.updatetime,
  };
}

function scriptNotFound(id: string): ManagedMcpError {
  return new ManagedMcpError(
    'SCRIPT_NOT_FOUND',
    'ScriptCat script not found.',
    {
      id,
    },
  );
}

function isUserscriptSource(source: string): boolean {
  return (
    /\/\/[ \t]*==UserScript==/.test(source) &&
    /\/\/[ \t]*==\/UserScript==/.test(source) &&
    /\/\/[ \t]*@name[ \t]+\S/.test(source)
  );
}

function uuidV5(value: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  const digest = createHash('sha1')
    .update(namespaceBytes)
    .update(value, 'utf8')
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
