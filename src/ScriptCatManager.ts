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
    send<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  };
}

interface RawExtension {
  id: string;
  path: string;
  version: string;
  enabled: boolean;
}

interface RawExtensionsResponse {
  extensions: RawExtension[];
}

interface RawLoadUnpackedResponse {
  id?: string;
}

export const SCRIPT_CAT_STARTUP_ACTION = {
  NOT_INITIALIZED: 'not-initialized',
  EXISTING: 'existing',
  LOADED: 'loaded',
  ACCESS_REPAIRED: 'access-repaired',
} as const;

export type ScriptCatStartupAction =
  (typeof SCRIPT_CAT_STARTUP_ACTION)[keyof typeof SCRIPT_CAT_STARTUP_ACTION];

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
  startupAction: ScriptCatStartupAction;
  installCount: number;
  accessRepairCount: number;
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

export type ManagedExtensionMutation =
  'install' | 'reload' | 'uninstall' | 'disable-user-scripts';

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

export class ScriptCatManager {
  readonly #browser: Browser;
  readonly #extensionPath: string;
  readonly #extensionId: string;
  readonly #repositoryRoot: string;
  readonly #timeout: number;
  readonly #backend: ScriptCatBackend;
  readonly #extensionVersion: string;
  #startupAction: ScriptCatStartupAction =
    SCRIPT_CAT_STARTUP_ACTION.NOT_INITIALIZED;
  #installCount = 0;
  #accessRepairCount = 0;

  private constructor(
    browser: Browser,
    options: ScriptCatManagerOptions,
    extensionPath: string,
    repositoryRoot: string,
    extensionVersion: string,
  ) {
    this.#browser = browser;
    this.#extensionPath = extensionPath;
    this.#extensionId = options.extensionId;
    this.#repositoryRoot = repositoryRoot;
    this.#timeout = options.timeout;
    this.#extensionVersion = extensionVersion;
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
    const extensionVersion = await manifestVersion(extensionPath);
    return new ScriptCatManager(
      browser,
      options,
      extensionPath,
      repositoryRoot,
      extensionVersion,
    );
  }

  async initialize(): Promise<void> {
    let extension = this.#findManagedExtension(await this.#getExtensions());
    if (!extension) {
      await this.#loadManagedExtension();
      this.#installCount += 1;
      this.#startupAction = SCRIPT_CAT_STARTUP_ACTION.LOADED;
      extension = this.#findManagedExtension(await this.#getExtensions());
      if (!extension) {
        throw this.#notReady('The managed ScriptCat extension was not loaded.');
      }
    } else {
      this.#startupAction = SCRIPT_CAT_STARTUP_ACTION.EXISTING;
    }
    this.#assertManagedExtension(extension);

    const accessEnabled = await this.#ensureUserScriptsAccess();
    if (!accessEnabled) {
      await setExtensionUserScriptsAccess(
        this.#browser,
        this.#extensionId,
        true,
      );
      this.#accessRepairCount += 1;
      this.#startupAction = SCRIPT_CAT_STARTUP_ACTION.ACCESS_REPAIRED;
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
        startupAction: this.#startupAction,
        installCount: this.#installCount,
        accessRepairCount: this.#accessRepairCount,
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
      startupAction: this.#startupAction,
      installCount: this.#installCount,
      accessRepairCount: this.#accessRepairCount,
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

  async #ensureUserScriptsAccess(): Promise<boolean> {
    const accessEnabled = await this.#backend.userScriptsAccessEnabled();
    if (accessEnabled !== null) {
      return accessEnabled;
    }
    await this.#startManagedServiceWorker();
    return await this.#waitForUserScriptsAccess();
  }

  async #startManagedServiceWorker(): Promise<void> {
    try {
      const pageTarget = this.#browser
        .targets()
        .find(target => target.type() === 'page');
      if (!pageTarget) {
        throw new Error(
          'No existing page target is available for CDP startup.',
        );
      }
      const session = await pageTarget.createCDPSession();
      await session.send('ServiceWorker.enable');
      await session.send('ServiceWorker.startWorker', {
        scopeURL: `chrome-extension://${this.#extensionId}/`,
      });
    } catch (error) {
      throw new ManagedMcpError(
        'BROWSER_UNSUPPORTED',
        'The browser does not support starting the managed ScriptCat service worker.',
        {extensionId: this.#extensionId},
        {cause: error},
      );
    }
  }

  async #waitForUserScriptsAccess(): Promise<boolean> {
    const deadline = Date.now() + this.#timeout;
    while (Date.now() < deadline) {
      const accessEnabled = await this.#backend.userScriptsAccessEnabled();
      if (accessEnabled !== null) {
        return accessEnabled;
      }
      await delay(100);
    }
    throw this.#notReady(
      'The managed ScriptCat service worker did not become available after startup.',
      {extensionId: this.#extensionId},
    );
  }

  async #getExtensions(): Promise<RawExtension[]> {
    const connection = this.#connection();
    let response: RawExtensionsResponse;
    try {
      response = await connection.send<RawExtensionsResponse>(
        'Extensions.getExtensions',
      );
    } catch (error) {
      throw new ManagedMcpError(
        'BROWSER_UNSUPPORTED',
        'The browser does not support Extensions.getExtensions.',
        {},
        {cause: error},
      );
    }
    if (!Array.isArray(response.extensions)) {
      throw this.#notReady('The browser returned an invalid extension list.');
    }
    return response.extensions;
  }

  #findManagedExtension(extensions: RawExtension[]): RawExtension | undefined {
    const pathMatches = extensions.filter(
      extension => extension.path === this.#extensionPath,
    );
    if (pathMatches.length > 1) {
      throw this.#notReady(
        'The managed ScriptCat extension path appears more than once.',
      );
    }
    if (pathMatches.length === 1 && pathMatches[0]?.id !== this.#extensionId) {
      throw this.#notReady(
        'The managed ScriptCat extension path belongs to an unexpected ID.',
        {
          expectedId: this.#extensionId,
          actualId: pathMatches[0]?.id,
        },
      );
    }
    const matches = extensions.filter(
      extension => extension.id === this.#extensionId,
    );
    if (matches.length > 1) {
      throw this.#notReady(
        'The managed ScriptCat extension appears more than once.',
      );
    }
    return matches[0];
  }

  #assertManagedExtension(extension: RawExtension): void {
    if (
      extension.id !== this.#extensionId ||
      extension.path !== this.#extensionPath ||
      extension.version !== this.#extensionVersion ||
      !extension.enabled
    ) {
      throw this.#notReady(
        'The managed ScriptCat extension does not match its pinned release.',
        {
          actual: extension,
          expected: {
            id: this.#extensionId,
            path: this.#extensionPath,
            version: this.#extensionVersion,
            enabled: true,
          },
        },
      );
    }
  }

  async #loadManagedExtension(): Promise<void> {
    const connection = this.#connection();
    const response = await connection.send<RawLoadUnpackedResponse>(
      'Extensions.loadUnpacked',
      {
        path: this.#extensionPath,
        expectedId: this.#extensionId,
        userScriptsAccess: true,
      },
    );
    if (response.id !== undefined && response.id !== this.#extensionId) {
      throw this.#notReady(
        'The managed ScriptCat extension ID does not match the pinned ID.',
        {
          expectedId: this.#extensionId,
          loadedId: response.id,
        },
      );
    }
  }

  #connection(): NonNullable<RawCdpBrowser['_connection']> {
    const connection = (this.#browser as RawCdpBrowser)._connection;
    if (!connection) {
      throw new ManagedMcpError(
        'BROWSER_UNSUPPORTED',
        'The browser does not expose a root CDP connection.',
      );
    }
    return connection;
  }

  #notReady(
    message: string,
    details: Record<string, unknown> = {},
  ): ManagedMcpError {
    return new ManagedMcpError('EXTENSION_NOT_READY', message, details);
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

async function manifestVersion(extensionPath: string): Promise<string> {
  try {
    const manifest = JSON.parse(
      await fs.readFile(path.join(extensionPath, 'manifest.json'), 'utf8'),
    ) as {version?: unknown};
    if (typeof manifest.version !== 'string' || manifest.version === '') {
      throw new Error('manifest version is missing');
    }
    return manifest.version;
  } catch (error) {
    throw new ManagedMcpError(
      'EXTENSION_NOT_READY',
      'The managed ScriptCat extension manifest has no valid version.',
      {extensionPath},
      {cause: error},
    );
  }
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
