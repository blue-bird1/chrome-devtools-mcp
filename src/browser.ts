/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execSync, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {logger} from './logger.js';
import {
  acquireProfileLock,
  type ProfileLockOwner,
  releaseProfileLock,
} from './ProfileLock.js';
import type {
  Browser,
  ChromeReleaseChannel,
  LaunchOptions,
  Target,
} from './third_party/index.js';
import {puppeteer} from './third_party/index.js';

let browser: Browser | undefined;
let browserMode: 'launched' | 'connected' | undefined;
let browserProfileLockOwner: ProfileLockOwner | undefined;
let browserLaunchPromise: Promise<Browser> | undefined;
let browserClosePromise: Promise<void> | undefined;

const PROCESS_EXIT_TIMEOUT_MS = 2_000;
const BROWSER_CLOSE_TIMEOUT_MS = 2_000;

function makeTargetFilter(enableExtensions = false) {
  const ignoredPrefixes = new Set(['chrome://', 'chrome-untrusted://']);
  if (!enableExtensions) {
    ignoredPrefixes.add('chrome-extension://');
  }

  return function targetFilter(target: Target): boolean {
    if (target.url() === 'chrome://newtab/') {
      return true;
    }
    // Could be the only page opened in the browser.
    if (target.url().startsWith('chrome://inspect')) {
      return true;
    }
    for (const prefix of ignoredPrefixes) {
      if (target.url().startsWith(prefix)) {
        return false;
      }
    }
    return true;
  };
}

export async function ensureBrowserConnected(options: {
  browserURL?: string;
  wsEndpoint?: string;
  wsHeaders?: Record<string, string>;
  devtools: boolean;
  channel?: Channel;
  userDataDir?: string;
  enableExtensions?: boolean;
  blocklist?: string[];
  allowlist?: string[];
}) {
  const {channel, enableExtensions} = options;
  if (browser?.connected) {
    return browser;
  }

  const connectOptions: Parameters<typeof puppeteer.connect>[0] = {
    targetFilter: makeTargetFilter(enableExtensions),
    defaultViewport: null,
    handleDevToolsAsPage: true,
    blocklist: options.blocklist,
    allowlist: options.allowlist,
  };

  let autoConnect = false;
  if (options.wsEndpoint) {
    connectOptions.browserWSEndpoint = options.wsEndpoint;
    if (options.wsHeaders) {
      connectOptions.headers = options.wsHeaders;
    }
  } else if (options.browserURL) {
    connectOptions.browserURL = options.browserURL;
  } else if (channel || options.userDataDir) {
    const userDataDir = options.userDataDir;
    if (userDataDir) {
      autoConnect = true;
      // TODO: re-expose this logic via Puppeteer.
      const portPath = path.join(userDataDir, 'DevToolsActivePort');
      try {
        const fileContent = await fs.promises.readFile(portPath, 'utf8');
        const [rawPort, rawPath] = fileContent
          .split('\n')
          .map(line => {
            return line.trim();
          })
          .filter(line => {
            return !!line;
          });
        if (!rawPort || !rawPath) {
          throw new Error(`Invalid DevToolsActivePort '${fileContent}' found`);
        }
        const port = parseInt(rawPort, 10);
        if (isNaN(port) || port <= 0 || port > 65535) {
          throw new Error(`Invalid port '${rawPort}' found`);
        }
        const browserWSEndpoint = `ws://127.0.0.1:${port}${rawPath}`;
        connectOptions.browserWSEndpoint = browserWSEndpoint;
      } catch (error) {
        throw new Error(
          `Could not connect to Chrome in ${userDataDir}. Check if Chrome is running and remote debugging is enabled by going to chrome://inspect/#remote-debugging.`,
          {
            cause: error,
          },
        );
      }
    } else {
      if (!channel) {
        throw new Error('Channel must be provided if userDataDir is missing');
      }
      connectOptions.channel = (
        channel === 'stable' ? 'chrome' : `chrome-${channel}`
      ) as ChromeReleaseChannel;
    }
  } else {
    throw new Error(
      'Either browserURL, wsEndpoint, channel or userDataDir must be provided',
    );
  }

  logger?.('Connecting Puppeteer to ', JSON.stringify(connectOptions));
  try {
    // Assign mode before browser so a concurrent closeBrowser() never sees
    // `browser` set with `browserMode` still undefined (would fall through
    // to the disconnect() path and orphan a launched Chrome).
    const connected = await puppeteer.connect(connectOptions);
    browserMode = 'connected';
    browser = connected;
  } catch (err) {
    throw new Error(
      `Could not connect to Chrome. ${autoConnect ? `Check if Chrome is running and remote debugging is enabled by going to chrome://inspect/#remote-debugging.` : `Check if Chrome is running.`}`,
      {
        cause: err,
      },
    );
  }
  logger?.('Connected Puppeteer');
  return browser;
}

interface McpLaunchOptions {
  acceptInsecureCerts?: boolean;
  executablePath?: string;
  channel?: Channel;
  userDataDir?: string;
  headless: boolean;
  isolated: boolean;
  logFile?: fs.WriteStream;
  viewport?: {
    width: number;
    height: number;
  };
  chromeArgs?: string[];
  ignoreDefaultChromeArgs?: string[];
  devtools: boolean;
  enableExtensions?: boolean;
  viaCli?: boolean;
  blocklist?: string[];
  allowlist?: string[];
  profileLock?: boolean;
}

export function detectDisplay(): void {
  // Only detect display on Linux/UNIX.
  if (os.platform() === 'win32' || os.platform() === 'darwin') {
    return;
  }
  if (!process.env['DISPLAY']) {
    try {
      const result = execSync(
        `ps -u $(id -u) -o pid= | xargs -I{} cat /proc/{}/environ 2>/dev/null | tr '\\0' '\\n' | grep -m1 '^DISPLAY=' | cut -d= -f2`,
      );
      const display = result.toString('utf8').trim();
      process.env['DISPLAY'] = display;
    } catch {
      // no-op
    }
  }
}

export async function launch(options: McpLaunchOptions): Promise<Browser> {
  const {channel, executablePath, headless, isolated} = options;
  const profileDirName =
    channel && channel !== 'stable'
      ? `chrome-profile-${channel}`
      : 'chrome-profile';

  let userDataDir = options.userDataDir;
  if (!isolated && !userDataDir) {
    userDataDir = path.join(
      os.homedir(),
      '.cache',
      options.viaCli ? 'chrome-devtools-mcp-cli' : 'chrome-devtools-mcp',
      profileDirName,
    );
    await fs.promises.mkdir(userDataDir, {
      recursive: true,
    });
  }

  const args: LaunchOptions['args'] = [
    ...(options.chromeArgs ?? []),
    '--hide-crash-restore-bubble',
  ];
  const ignoreDefaultArgs: LaunchOptions['ignoreDefaultArgs'] =
    options.ignoreDefaultChromeArgs ?? false;

  if (headless) {
    args.push('--screen-info={3840x2160}');
  }
  let puppeteerChannel: ChromeReleaseChannel | undefined;
  if (options.devtools) {
    args.push('--auto-open-devtools-for-tabs');
  }
  if (!executablePath) {
    puppeteerChannel =
      channel && channel !== 'stable'
        ? (`chrome-${channel}` as ChromeReleaseChannel)
        : 'chrome';
  }

  if (!headless) {
    detectDisplay();
  }

  try {
    const browser = await puppeteer.launch({
      channel: puppeteerChannel,
      targetFilter: makeTargetFilter(options.enableExtensions),
      executablePath,
      defaultViewport: null,
      userDataDir,
      pipe: true,
      headless,
      args,
      ignoreDefaultArgs: ignoreDefaultArgs,
      acceptInsecureCerts: options.acceptInsecureCerts,
      handleDevToolsAsPage: true,
      enableExtensions: options.enableExtensions,
      blocklist: options.blocklist,
      allowlist: options.allowlist,
    });
    if (options.logFile) {
      // FIXME: we are probably subscribing too late to catch startup logs. We
      // should expose the process earlier or expose the getRecentLogs() getter.
      browser.process()?.stderr?.pipe(options.logFile);
      browser.process()?.stdout?.pipe(options.logFile);
    }
    if (options.viewport) {
      const [page] = await browser.pages();
      await page?.resize({
        contentWidth: options.viewport.width,
        contentHeight: options.viewport.height,
      });
    }
    return browser;
  } catch (error) {
    if (
      userDataDir &&
      (error as Error).message.includes('The browser is already running')
    ) {
      throw new Error(
        `The browser is already running for ${userDataDir}. Use --isolated to run multiple browser instances.`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}

export async function ensureBrowserLaunched(
  options: McpLaunchOptions,
): Promise<Browser> {
  while (true) {
    if (browserClosePromise) {
      await browserClosePromise;
      continue;
    }
    if (browser?.connected) {
      return browser;
    }
    if (browser && browserMode === 'launched') {
      await closeBrowser();
      continue;
    }
    if (browserLaunchPromise) {
      return await browserLaunchPromise;
    }
    break;
  }

  const profileLockOwner: ProfileLockOwner = {};
  const launchPromise = (async (): Promise<Browser> => {
    let profileLockAcquired = false;
    try {
      if (options.profileLock) {
        if (!options.userDataDir) {
          throw new Error(
            'A user data directory is required for profile locking.',
          );
        }
        await acquireProfileLock(options.userDataDir, profileLockOwner);
        profileLockAcquired = true;
      }
      const launched = await launch(options);
      // Assign mode and ownership before browser; see the connect path above
      // for rationale.
      browserMode = 'launched';
      browserProfileLockOwner = profileLockAcquired
        ? profileLockOwner
        : undefined;
      browser = launched;
      return browser;
    } catch (error) {
      if (profileLockAcquired) {
        await releaseProfileLock(profileLockOwner);
      }
      throw error;
    }
  })();
  browserLaunchPromise = launchPromise;
  try {
    return await launchPromise;
  } finally {
    if (browserLaunchPromise === launchPromise) {
      browserLaunchPromise = undefined;
    }
  }
}

/**
 * Shutdown hook for the active browser. Closes a launched browser (so the
 * Chrome subprocess is reaped) or disconnects from an attached browser (so
 * the user's Chrome instance stays alive). A launched browser remains owned
 * until its OS process exits, even if its CDP connection has already dropped.
 * Called from the server entrypoint on stdin EOF / SIGTERM / SIGINT.
 */
export async function closeBrowser(): Promise<void> {
  if (browserClosePromise) {
    return await browserClosePromise;
  }

  const closePromise = closeActiveBrowser();
  browserClosePromise = closePromise;
  try {
    await closePromise;
  } finally {
    if (browserClosePromise === closePromise) {
      browserClosePromise = undefined;
    }
  }
}

export async function closeBrowserWithBackstop(
  onTimeout: () => void,
  timeout = 10_000,
): Promise<void> {
  const timeoutId = setTimeout(onTimeout, timeout);
  timeoutId.unref();
  try {
    await closeBrowser();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function closeActiveBrowser(): Promise<void> {
  const launchPromise = browserLaunchPromise;
  if (launchPromise) {
    try {
      await launchPromise;
    } catch {
      return;
    }
  }

  const b = browser;
  const mode = browserMode;
  const profileLockOwner = browserProfileLockOwner;
  browser = undefined;
  browserMode = undefined;
  browserProfileLockOwner = undefined;
  if (!b) {
    return;
  }
  if (mode === 'launched') {
    await closeLaunchedBrowser(b);
    if (profileLockOwner) {
      try {
        await releaseProfileLock(profileLockOwner);
      } catch (error) {
        logger?.('Failed to release the managed profile lock', error);
      }
    }
    return;
  }
  if (!b.connected) {
    return;
  }
  await b.disconnect().catch(err => {
    logger?.('Failed to disconnect from browser', err);
  });
}

async function closeLaunchedBrowser(b: Browser): Promise<void> {
  const child = b.process();
  if (!child) {
    throw new Error('The launched browser does not expose its OS process.');
  }

  if (b.connected) {
    await closeBrowserOverCdp(b);
  }

  if (isProcessExited(child)) {
    return;
  }

  stopBrowserProcess(child, 'SIGTERM');
  if (await waitForProcessExit(child, PROCESS_EXIT_TIMEOUT_MS)) {
    return;
  }

  stopBrowserProcess(child, 'SIGKILL');
  if (await waitForProcessExit(child, PROCESS_EXIT_TIMEOUT_MS)) {
    return;
  }

  logger?.('Chrome did not exit after SIGKILL; waiting to reap it.');
  await waitForProcessExit(child);
}

async function closeBrowserOverCdp(b: Browser): Promise<void> {
  let timeoutId: NodeJS.Timeout | undefined;
  const close = b.close().then(
    () => true,
    error => {
      logger?.('Failed to close browser over CDP', error);
      return true;
    },
  );
  const closeSettled = await Promise.race([
    close,
    new Promise<boolean>(resolve => {
      timeoutId = setTimeout(() => {
        resolve(false);
      }, BROWSER_CLOSE_TIMEOUT_MS);
    }),
  ]);
  if (timeoutId) {
    clearTimeout(timeoutId);
  }
  if (!closeSettled) {
    logger?.('Timed out closing browser over CDP; terminating Chrome.');
  }
}

function isProcessExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function stopBrowserProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch (error) {
    logger?.(`Failed to send ${signal} to Chrome`, error);
  }
}

async function waitForProcessExit(
  child: ChildProcess,
  timeout?: number,
): Promise<boolean> {
  if (isProcessExited(child)) {
    return true;
  }
  return await new Promise(resolve => {
    let timeoutId: NodeJS.Timeout | undefined;
    const finish = (exited: boolean) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => {
      finish(true);
    };
    child.once('exit', onExit);
    if (isProcessExited(child)) {
      finish(true);
      return;
    }
    if (timeout !== undefined) {
      timeoutId = setTimeout(() => {
        finish(false);
      }, timeout);
    }
  });
}

export type Channel = 'stable' | 'canary' | 'beta' | 'dev';
