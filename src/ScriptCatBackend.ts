/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ManagedMcpError, type ManagedMcpErrorCode} from './ManagedMcpError.js';
import type {Browser, Page, Target} from './third_party/index.js';

const OFFSCREEN_PATH = '/src/offscreen.html';
const TRANSPORT_PROBE_ACTION = 'serviceWorker/script/getSource';
const TRANSPORT_PROBE_SCRIPT_ID = '__scriptcat_mcp_capability_probe__';

interface ScriptCatMessageResponse<T> {
  code: number;
  data?: T;
  message?: string;
}

interface ScriptCatDelivery<T> {
  response?: ScriptCatMessageResponse<T>;
  transportError?: string;
}

export class ScriptCatBackend {
  readonly #browser: Browser;
  readonly #extensionId: string;
  readonly #timeout: number;

  constructor(browser: Browser, extensionId: string, timeout: number) {
    this.#browser = browser;
    this.#extensionId = extensionId;
    this.#timeout = timeout;
  }

  async transportReady(): Promise<boolean> {
    try {
      const response = await this.send<unknown>(
        TRANSPORT_PROBE_ACTION,
        TRANSPORT_PROBE_SCRIPT_ID,
      );
      return response === null;
    } catch {
      return false;
    }
  }

  async userScriptsAccessEnabled(): Promise<boolean | null> {
    const target = this.#findServiceWorkerTarget();
    if (!target) {
      return null;
    }
    try {
      const worker = await target.worker();
      if (!worker) {
        return null;
      }
      return await withTimeout(
        worker.evaluate(async () => {
          try {
            const chromeApi = globalThis as unknown as {
              chrome?: {
                userScripts?: {
                  getScripts(options: {ids: string[]}): Promise<unknown>;
                };
              };
            };
            const userScripts = chromeApi.chrome?.userScripts;
            if (typeof userScripts?.getScripts !== 'function') {
              return false;
            }
            return Array.isArray(await userScripts.getScripts({ids: []}));
          } catch {
            return false;
          }
        }),
        this.#timeout,
        'userScripts access probe',
      );
    } catch {
      return null;
    }
  }

  async send<T>(
    action: string,
    data?: unknown,
    backendErrorCode?: ManagedMcpErrorCode,
  ): Promise<T> {
    let delivery: ScriptCatDelivery<T>;
    const deadline = Date.now() + this.#timeout;
    const attemptedTargets = new Set<Target>();
    while (true) {
      try {
        const {page} = await this.#getOffscreenPage(attemptedTargets, deadline);
        delivery = await withTimeout(
          page.evaluate(
            async payload => {
              const runtime = (
                globalThis as unknown as {
                  chrome: {
                    runtime: {
                      lastError?: {message?: string};
                      sendMessage(
                        message: unknown,
                        callback: (response: unknown) => void,
                      ): void;
                    };
                  };
                }
              ).chrome.runtime;
              return await new Promise<ScriptCatDelivery<unknown>>(resolve => {
                runtime.sendMessage(
                  {action: payload.action, data: payload.data},
                  response => {
                    const transportError = runtime.lastError?.message;
                    resolve(
                      transportError
                        ? {transportError}
                        : {
                            response:
                              response as ScriptCatMessageResponse<unknown>,
                          },
                    );
                  },
                );
              });
            },
            {action, data},
          ) as Promise<ScriptCatDelivery<T>>,
          remainingTimeout(deadline),
          action,
        );
        break;
      } catch (error) {
        if (isRetryableTargetError(error) && Date.now() < deadline) {
          continue;
        }
        if (error instanceof ManagedMcpError) {
          throw error;
        }
        if (error instanceof Error && error.name === 'TimeoutError') {
          throw new ManagedMcpError(
            'TIMEOUT',
            'Timed out waiting for the ScriptCat offscreen message transport.',
            {action, timeout: this.#timeout},
            {cause: error},
          );
        }
        throw new ManagedMcpError(
          'EXTENSION_NOT_READY',
          'Failed to call the ScriptCat service-worker backend.',
          {action},
          {cause: error},
        );
      }
    }

    if (delivery.transportError) {
      throw new ManagedMcpError(
        'EXTENSION_NOT_READY',
        'ScriptCat rejected the backend message transport.',
        {action, transportError: delivery.transportError},
      );
    }
    const response = delivery.response;
    if (!response || typeof response.code !== 'number') {
      throw new ManagedMcpError(
        'EXTENSION_NOT_READY',
        'ScriptCat returned an invalid backend response.',
        {action},
      );
    }
    if (response.code !== 0) {
      const code = response.message?.includes('script not found')
        ? 'SCRIPT_NOT_FOUND'
        : (backendErrorCode ?? 'EXTENSION_NOT_READY');
      throw new ManagedMcpError(
        code,
        response.message ?? 'ScriptCat backend request failed.',
        {action},
      );
    }
    return response.data as T;
  }

  #findOffscreenTargets(): Target[] {
    return this.#browser
      .targets()
      .filter(target => this.#isOffscreenTarget(target));
  }

  #isOffscreenTarget(target: Target): boolean {
    const expectedPrefix = `chrome-extension://${this.#extensionId}`;
    return (
      target.url().startsWith(expectedPrefix) &&
      target.url().endsWith(OFFSCREEN_PATH)
    );
  }

  #findServiceWorkerTarget(): Target | undefined {
    const expectedPrefix = `chrome-extension://${this.#extensionId}/`;
    return this.#browser
      .targets()
      .find(
        target =>
          target.type() === 'service_worker' &&
          target.url().startsWith(expectedPrefix),
      );
  }

  async #getOffscreenPage(
    attemptedTargets: Set<Target>,
    deadline: number,
  ): Promise<{page: Page; target: Target}> {
    while (true) {
      const target = this.#findOffscreenTargets().find(
        candidate => !attemptedTargets.has(candidate),
      );
      if (target) {
        attemptedTargets.add(target);
        try {
          const page = (await target.page()) ?? (await target.asPage());
          if (page) {
            return {page, target};
          }
        } catch (error) {
          if (!isRetryableTargetError(error)) {
            throw error;
          }
        }
        continue;
      }
      const replacement = await this.#browser.waitForTarget(
        candidate =>
          this.#isOffscreenTarget(candidate) &&
          !attemptedTargets.has(candidate),
        {timeout: remainingTimeout(deadline)},
      );
      attemptedTargets.add(replacement);
      try {
        const page = (await replacement.page()) ?? (await replacement.asPage());
        if (page) {
          return {page, target: replacement};
        }
      } catch (error) {
        if (!isRetryableTargetError(error)) {
          throw error;
        }
      }
    }
  }
}

function remainingTimeout(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function isRetryableTargetError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('Target closed') ||
      error.message.includes('Execution context was destroyed'))
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeout: number,
  action: string,
): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new ManagedMcpError(
              'TIMEOUT',
              'Timed out waiting for a ScriptCat backend response.',
              {action, timeout},
            ),
          );
        }, timeout);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
