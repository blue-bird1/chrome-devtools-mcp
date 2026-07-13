/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type ManagedMcpErrorCode =
  | 'PROFILE_BUSY'
  | 'BROWSER_UNSUPPORTED'
  | 'EXTENSION_NOT_READY'
  | 'INVALID_USERSCRIPT'
  | 'SCRIPT_NOT_FOUND'
  | 'TIMEOUT';

export class ManagedMcpError extends Error {
  readonly code: ManagedMcpErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: ManagedMcpErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(JSON.stringify({code, message, ...details}), options);
    this.name = 'ManagedMcpError';
    this.code = code;
    this.details = details;
  }
}
