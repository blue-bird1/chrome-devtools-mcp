/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {once} from 'node:events';
import process from 'node:process';

import {closeBrowser, ensureBrowserLaunched} from '../../src/browser.js';

const [profile, browserExecutable] = process.argv.slice(2);
if (!profile || !browserExecutable) {
  throw new Error('The managed browser owner requires a profile and browser.');
}

const browser = await ensureBrowserLaunched({
  headless: true,
  isolated: false,
  userDataDir: profile,
  executablePath: browserExecutable,
  devtools: false,
  profileLock: true,
});
const browserProcess = browser.process();
if (!browserProcess?.pid) {
  throw new Error('The managed browser did not expose its process ID.');
}

process.stdout.write(`${browserProcess.pid}\n`);
process.stdin.resume();
await once(process.stdin, 'end');
await closeBrowser();
