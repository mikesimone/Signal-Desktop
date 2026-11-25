// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Backchannel: not made, endorsed or supported by Signal Messenger.
//
// The Backchannel app (contrib/backchannel/mac) runs the Backchannel helper
// inside itself and shows its page in its own window:
//
//   Backchannel window ──http://127.0.0.1:<port>/<token>/──▶ helper ──socket──▶ bridge
//   (sandboxed, own session)                     (utility process)
//
// Signal's own window stays for linking and the approval dialog. Once the
// helper is approved and connected, the Backchannel window becomes the main
// one and Signal's is hidden; Window > Show and the Dock menu bring it back.

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import {
  app,
  BrowserWindow,
  Menu,
  session,
  shell,
  utilityProcess,
} from 'electron';
import type { UtilityProcess } from 'electron';

import { createLogger } from '../logging/log.std.ts';
import * as Errors from '../types/errors.std.ts';
import { drop } from '../util/drop.std.ts';
import { isBackchannelApp } from './config.main.ts';

const log = createLogger('backchannel');

// The helper's default port, then a few more in case something else (another
// copy of the helper, say) already has it.
const FIRST_PORT = 47830;
const LAST_PORT = 47839;
const PARTITION = 'persist:backchannel';
// What the page may ask for: its notifications, copying, voice notes
// (microphone only) and full-screen video. Everything else is refused.
const ALLOWED_PERMISSIONS = new Set([
  'notifications',
  'clipboard-sanitized-write',
  'media',
  'fullscreen',
]);
const RESTART_DELAYS_MS = [1_000, 5_000, 30_000];

type OptionsType = Readonly<{
  userDataPath: string;
  getMainWindow: () => BrowserWindow | undefined;
}>;

let instance: BackchannelApp | undefined;

// Called once from app/main.main.ts when Signal is ready. Does nothing outside
// the Backchannel app.
export function startBackchannelApp(options: OptionsType): void {
  if (instance || !isBackchannelApp()) {
    return;
  }
  instance = new BackchannelApp(options);
  drop(instance.start());
}

// For app/main.main.ts's Dock-click handler: true when it showed the
// Backchannel window, so Signal's window stays where it is.
export function showBackchannelWindow(): boolean {
  return instance?.showWindowIfMain() ?? false;
}

// While the page is the main window its unread count is the Dock badge, and
// Signal's own count (which includes chats the page doesn't count) is ignored.
export function backchannelOwnsBadge(): boolean {
  return instance?.ownsBadge() ?? false;
}

class BackchannelApp {
  readonly #options: OptionsType;
  readonly #configDir: string;
  #child: UtilityProcess | undefined;
  #port: number | undefined;
  #window: BrowserWindow | undefined;
  #state = 'offline';
  #becameMain = false;
  #quitting = false;
  #restarts = 0;

  constructor(options: OptionsType) {
    this.#options = options;
    // Key, token, scheduled messages and the emoji font cache.
    this.#configDir = join(options.userDataPath, 'backchannel');
  }

  async start(): Promise<void> {
    app.on('before-quit', () => {
      this.#quitting = true;
    });
    app.on('will-quit', () => {
      // SIGTERM: the helper stops its timers and closes its sockets.
      this.#child?.kill();
    });
    this.#setDockMenu();

    try {
      this.#port = await findFreePort();
    } catch (error) {
      log.error('no free port', Errors.toLogFormat(error));
      return;
    }
    this.#spawn();
  }

  showWindowIfMain(): boolean {
    if (!this.#becameMain) {
      return false;
    }
    this.#showWindow();
    return true;
  }

  ownsBadge(): boolean {
    return this.#becameMain && this.#window !== undefined;
  }

  #spawn(): void {
    const port = this.#port;
    if (port === undefined) {
      return;
    }
    const script = join(
      app.getAppPath(),
      'contrib',
      'backchannel',
      'helper',
      'backchannel.mjs'
    );
    // The container's flags (contrib/backchannel/entrypoint.sh), except that
    // the page is served on loopback only and the config lives in our profile.
    const child = utilityProcess.fork(
      script,
      [
        '--user-data',
        this.#options.userDataPath,
        '--config',
        this.#configDir,
        '--bind',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      { serviceName: 'Backchannel helper', stdio: 'pipe' }
    );
    this.#child = child;

    // The helper never logs its token when its output isn't a terminal.
    child.stdout?.on('data', (chunk: Buffer<ArrayBuffer>) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) {
          log.info(`helper: ${line.trim()}`);
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer<ArrayBuffer>) => {
      log.warn(`helper: ${chunk.toString('utf8').trim()}`);
    });
    child.on('message', (message: unknown) => this.#onMessage(message));
    child.on('exit', code => {
      this.#child = undefined;
      if (this.#quitting) {
        return;
      }
      const delay =
        RESTART_DELAYS_MS[
          Math.min(this.#restarts, RESTART_DELAYS_MS.length - 1)
        ];
      this.#restarts += 1;
      log.warn(`helper exited with code ${code}; restarting in ${delay} ms`);
      setTimeout(() => this.#spawn(), delay);
    });
    log.info(`helper started on 127.0.0.1:${port}`);
  }

  #onMessage(message: unknown): void {
    if (
      typeof message !== 'object' ||
      message == null ||
      !('type' in message) ||
      message.type !== 'state' ||
      !('state' in message) ||
      typeof message.state !== 'string'
    ) {
      return;
    }
    const { state } = message;
    if (state === this.#state) {
      return;
    }
    log.info(`helper state: ${state}`);
    this.#state = state;

    if (state === 'ready') {
      this.#restarts = 0;
      if (!this.#becameMain) {
        // First approval and connection in this run: the page takes over.
        this.#becameMain = true;
        this.#showWindow();
        this.#options.getMainWindow()?.hide();
      }
    } else if (
      state === 'unlinked' ||
      state === 'denied' ||
      state === 'keyMismatch'
    ) {
      // These need Signal's window: the link code, or Settings > Privacy >
      // Apps on this computer. (Signal shows it for its approval dialog.)
      this.#options.getMainWindow()?.show();
    }
  }

  #pageUrl(): string | undefined {
    const tokenFile = join(this.#configDir, 'token');
    if (this.#port === undefined || !existsSync(tokenFile)) {
      return undefined;
    }
    const token = readFileSync(tokenFile, 'utf8').trim();
    return `http://127.0.0.1:${this.#port}/${token}/`;
  }

  #showWindow(): void {
    if (this.#window && !this.#window.isDestroyed()) {
      this.#window.show();
      return;
    }
    const url = this.#pageUrl();
    if (!url) {
      log.warn('showWindow: helper not started yet');
      return;
    }
    const origin = new URL(url).origin;
    const ses = session.fromPartition(PARTITION);
    const isPage = (requestUrl: string): boolean =>
      URL.canParse(requestUrl) && new URL(requestUrl).origin === origin;

    ses.setPermissionRequestHandler(
      (_contents, permission, callback, details) => {
        const audioOnly =
          permission !== 'media' ||
          ('mediaTypes' in details &&
            (details.mediaTypes ?? []).every(type => type === 'audio'));
        callback(
          isPage(details.requestingUrl) &&
            ALLOWED_PERMISSIONS.has(permission) &&
            audioOnly
        );
      }
    );
    ses.setPermissionCheckHandler(
      (_contents, permission, requestingOrigin) =>
        isPage(requestingOrigin) && ALLOWED_PERMISSIONS.has(permission)
    );

    const window = new BrowserWindow({
      title: 'Backchannel',
      width: 1100,
      height: 780,
      minWidth: 380,
      minHeight: 400,
      show: false,
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: true,
        // The page shows message notifications while it's hidden.
        backgroundThrottling: false,
      },
    });
    this.#window = window;

    const openOutside = (target: string): void => {
      if (/^https?:\/\//i.test(target) && !isPage(target)) {
        drop(shell.openExternal(target));
      }
    };
    window.webContents.setWindowOpenHandler(({ url: target }) => {
      openOutside(target);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, target) => {
      if (!target.startsWith(url)) {
        event.preventDefault();
        openOutside(target);
      }
    });
    window.webContents.on('will-attach-webview', event =>
      event.preventDefault()
    );

    // The page puts its unread count in its title: "(3) Backchannel".
    window.on('page-title-updated', (_event, title) => {
      const match = /^\((\d+)\)/.exec(title);
      app.setBadgeCount(match ? Number(match[1]) : 0);
    });
    // Closing hides it, as Signal's window does on the Mac, so the page keeps
    // showing notifications; quitting closes it for real.
    window.on('close', event => {
      if (!this.#quitting) {
        event.preventDefault();
        window.hide();
      }
    });
    window.on('closed', () => {
      this.#window = undefined;
    });
    window.once('ready-to-show', () => window.show());

    drop(window.loadURL(url));
  }

  #setDockMenu(): void {
    app.dock?.setMenu(
      Menu.buildFromTemplate([
        { label: 'Backchannel', click: () => this.#showWindow() },
        {
          label: 'Signal Window',
          click: () => this.#options.getMainWindow()?.show(),
        },
      ])
    );
  }
}

async function findFreePort(): Promise<number> {
  for (let port = FIRST_PORT; port <= LAST_PORT; port += 1) {
    // oxlint-disable-next-line no-await-in-loop
    if (await isFree(port)) {
      return port;
    }
  }
  throw new Error(`ports ${FIRST_PORT} to ${LAST_PORT} are all in use`);
}

function isFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}
