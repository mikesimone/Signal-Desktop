#!/usr/bin/env node
// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// Backchannel: shows your Signal chats in a web page (Rambox, Ferdium or any
// browser) through this fork's external-client bridge in Signal Desktop. Not
// made or endorsed by Signal Messenger. No dependencies; Node 20+.
//
//   node backchannel.mjs              start; in a terminal, prints the URL
//                                     to open
//   node backchannel.mjs --url        print the URL and exit
//
// Options:
//   --user-data <dir>   Signal profile dir (default: the platform default)
//   --endpoint <path>   connect here instead of computing the endpoint
//   --port <n>          local port (default 47830)
//   --bind <address>    listen address (default 127.0.0.1; a container may
//                       need 0.0.0.0 behind its port mapping)
//   --origin <url>      also accept this origin, e.g. https://signal.example
//                       behind a reverse proxy (repeatable)
//   --config <dir>      where the key and token live (default: per-user config)
//
// The first run asks Signal for approval; answer the dialog in Signal.

import { randomBytes } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Bridge,
  BridgeState,
  defaultUserData,
  endpointFor,
} from './bridge.mjs';
import { ContactPhotoRefresh } from './contactPhotos.mjs';
import { largeEmojiFontLoader } from './fonts.mjs';
import { PrivateReplies } from './privateReplies.mjs';
import { ScheduledMessages } from './scheduled.mjs';
import { allowedOrigins, createWebServer } from './server.mjs';
import { Store } from './store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Signal's fonts (emoji and Inter): a copy next to the helper (the container
// image has one), else the Signal Desktop checkout this helper lives in.
const FONT_DIR = [
  join(HERE, 'fonts'),
  join(HERE, '..', '..', '..', 'fonts'),
].find(dir => existsSync(join(dir, 'emoji.woff2')));

function parseArgs(argv) {
  const out = { port: 47830, bind: '127.0.0.1', origins: [], printUrl: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--user-data') {
      out.userData = argv[++i];
    } else if (arg === '--endpoint') {
      out.endpoint = argv[++i];
    } else if (arg === '--bind') {
      out.bind = argv[++i];
    } else if (arg === '--origin') {
      const origin = new URL(argv[++i]).origin;
      out.origins.push(origin);
    } else if (arg === '--port') {
      out.port = Number(argv[++i]);
    } else if (arg === '--config') {
      out.configDir = argv[++i];
    } else if (arg === '--url') {
      out.printUrl = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(out.port) || out.port < 1024 || out.port > 65535) {
    throw new Error('--port must be between 1024 and 65535');
  }
  return out;
}

function defaultConfigDir() {
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA
      : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const dir = join(base, 'backchannel');
  // Before the rename to Backchannel the folder was signal-rambox. Moving it
  // keeps the page address (token) and Signal's approval (key).
  const old = join(base, 'signal-rambox');
  if (!existsSync(dir) && existsSync(old)) {
    try {
      renameSync(old, dir);
    } catch {
      return old;
    }
  }
  return dir;
}

// The token is the only secret in the page URL. It is created once and kept,
// so the page address does not change after a restart.
function loadToken(file) {
  if (existsSync(file)) {
    return readFileSync(file, 'utf8').trim();
  }
  const token = randomBytes(24).toString('base64url');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

// A closed console must not take the helper down.
process.stdout.on('error', () => {});

function log(message) {
  const now = new Date().toLocaleTimeString();
  process.stdout.write(`${now} ${message}\n`);
}

const args = parseArgs(process.argv.slice(2));
const configDir = args.configDir || defaultConfigDir();
const token = loadToken(join(configDir, 'token'));
const origins = allowedOrigins(args.port, args.origins);
// The page's address: the --origin name if there is one.
const url = `${args.origins[0] ?? origins[0]}/${token}/`;

if (args.printUrl) {
  process.stdout.write(`${url}\n`);
  process.exit(0);
}

const endpoint =
  args.endpoint || endpointFor(args.userData || defaultUserData());
const store = new Store();
// Assigned below; the bridge callbacks run only after start().
let web;

const bridge = new Bridge({
  endpoint,
  keyFile: join(configDir, 'key.json'),
  displayName: 'Backchannel',
  log,
  onState(state) {
    store.state = state === BridgeState.Ready ? 'loading' : state;
    if (state !== BridgeState.Ready) {
      store.clear();
    }
    web.broadcast('state', { state: store.state });
  },
  async onReady() {
    web.forgetCachedState();
    await store.load(bridge);
    store.state = BridgeState.Ready;
    log(`loaded ${store.snapshot().conversations.length} conversations`);
    web.broadcast('resync', {});
    // Anything that came due while Signal was away goes now.
    await scheduled.run(scheduled.ready);
    await contactPhotos.daily();
  },
  onEvent(event) {
    // Someone new in a 1:1 chat: the phone's contacts may have them.
    if (
      event.event === 'conversation.updated' &&
      event.data.type === 'direct' &&
      !event.data.noteToSelf &&
      !store.has(event.data.id)
    ) {
      contactPhotos.newChat();
    }
    store.apply(event);
    web.broadcast(event.event, event.data);
  },
});

// Scheduled messages (decision F29): sent through Signal when due.
const scheduled = new ScheduledMessages(configDir, {
  async send(item) {
    const attachmentUploadIds = [];
    for (const f of item.files) {
      // oxlint-disable-next-line no-await-in-loop
      const uploadId = await web.uploadStream(
        createReadStream(scheduled.filePath(f.fileId)),
        {
          size: f.size,
          contentType: f.contentType,
          fileName: f.fileName ?? undefined,
        }
      );
      if (!uploadId) {
        throw Object.assign(new Error('file changed'), {
          code: 'INVALID_ARGUMENT',
        });
      }
      attachmentUploadIds.push(uploadId);
    }
    await bridge.call('messages.sendText', {
      conversationId: item.conversationId,
      body: item.body,
      ...(item.mentions.length ? { mentions: item.mentions } : {}),
      ...(item.formatting.length ? { formatting: item.formatting } : {}),
      ...(item.quoteMessageId ? { quoteMessageId: item.quoteMessageId } : {}),
      ...(item.linkPreviewUrl && attachmentUploadIds.length === 0
        ? { linkPreviewUrl: item.linkPreviewUrl }
        : {}),
      ...(attachmentUploadIds.length ? { attachmentUploadIds } : {}),
    });
  },
  onChange() {
    web?.broadcast('scheduled.changed', { counts: scheduled.counts() });
  },
  log,
});
scheduled.ready = () => store.state === BridgeState.Ready;

const contactPhotos = new ContactPhotoRefresh(configDir, {
  sync: () => bridge.call('contacts.sync', {}),
  ready: () =>
    store.state === BridgeState.Ready &&
    bridge.capabilities.includes('settings.manage'),
  log,
});
contactPhotos.start();

web = createWebServer({
  port: args.port,
  bindAddress: args.bind,
  origins,
  token,
  publicDir: join(HERE, 'public'),
  fontDir: FONT_DIR,
  getLargeEmojiFont: largeEmojiFontLoader({
    userData: args.userData || (args.endpoint ? undefined : defaultUserData()),
    cacheFile: join(configDir, 'emoji-large.woff2'),
    log,
  }),
  store,
  bridge,
  privateReplies: new PrivateReplies(join(configDir, 'private-replies.json')),
  scheduled,
  contactPhotos,
  log,
});

try {
  await web.listen();
} catch (error) {
  log(`cannot listen on ${args.bind}:${args.port}: ${error.code}`);
  process.exit(1);
}

log(`endpoint: ${endpoint}`);
if (!FONT_DIR) {
  log("Signal's fonts not found; the page falls back to system emoji");
}
log(`client key: ${bridge.publicKey}`);
// The token is a secret, so it never goes to a log: only an interactive
// terminal sees the full URL. Elsewhere (a container, a service) use --url.
if (process.stdout.isTTY) {
  log(`open this URL (or add it to Rambox as a custom app): ${url}`);
} else {
  log(
    `serving ${args.origins[0] ?? origins[0]}/ (run with --url for the address)`
  );
}
bridge.start();
scheduled.start();

async function shutdown() {
  log('stopping');
  scheduled.stop();
  await bridge.stop();
  await web.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
