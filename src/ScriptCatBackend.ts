/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ManagedMcpError, type ManagedMcpErrorCode} from './ManagedMcpError.js';
import type {Browser, Page, Target} from './third_party/index.js';

const OFFSCREEN_PATH = '/src/offscreen.html';

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

  transportReady(): boolean {
    return Boolean(this.#findOffscreenTarget());
  }

  async send<T>(
    action: string,
    data?: unknown,
    backendErrorCode?: ManagedMcpErrorCode,
  ): Promise<T> {
    let delivery: ScriptCatDelivery<T>;
    try {
      const page = await this.#getOffscreenPage();
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
        this.#timeout,
        action,
      );
    } catch (error) {
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

  #findOffscreenTarget(): Target | undefined {
    const expectedPrefix = `chrome-extension://${this.#extensionId}`;
    return this.#browser
      .targets()
      .find(
        target =>
          target.url().startsWith(expectedPrefix) &&
          target.url().endsWith(OFFSCREEN_PATH),
      );
  }

  async #getOffscreenPage(): Promise<Page> {
    const target =
      this.#findOffscreenTarget() ??
      (await this.#browser.waitForTarget(
        candidate => {
          return (
            candidate
              .url()
              .startsWith(`chrome-extension://${this.#extensionId}`) &&
            candidate.url().endsWith(OFFSCREEN_PATH)
          );
        },
        {timeout: this.#timeout},
      ));
    const page = (await target.page()) ?? (await target.asPage());
    if (!page) {
      throw new ManagedMcpError(
        'EXTENSION_NOT_READY',
        'The ScriptCat offscreen message transport is unavailable.',
        {extensionId: this.#extensionId},
      );
    }
    return page;
  }
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
