#!/usr/bin/env node
// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// signal-rambox: shows Signal Desktop inside Rambox (or any app that hosts web
// pages) through Signal's external-client bridge. No dependencies; Node 20+.
//
//   node signal-rambox.mjs            start; prints the URL to add to Rambox
//   node signal-rambox.mjs --url      print the URL and exit
//
// Options:
//   --user-data <dir>   Signal profile dir (default: the platform default)
//   --endpoint <path>   connect here instead of computing the endpoint
//   --port <n>          local port (default 47830)
//   --config <dir>      where the key and token live (default: per-user config)
//
// The first run asks Signal for approval; answer the dialog in Signal.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Bridge,
  BridgeState,
  defaultUserData,
  endpointFor,
} from './bridge.mjs';
import { createWebServer } from './server.mjs';
import { Store } from './store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { port: 47830, printUrl: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--user-data') {
      out.userData = argv[++i];
    } else if (arg === '--endpoint') {
      out.endpoint = argv[++i];
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
  if (process.platform === 'win32') {
    return join(process.env.APPDATA, 'signal-rambox');
  }
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'signal-rambox'
  );
}

// The token is the only secret in the page URL. It is created once and kept,
// so the Rambox app does not need to be edited after a restart.
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
const url = `http://127.0.0.1:${args.port}/${token}/`;

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
  displayName: 'Rambox (signal-rambox)',
  log,
  onState(state) {
    store.state = state === BridgeState.Ready ? 'loading' : state;
    if (state !== BridgeState.Ready) {
      store.clear();
    }
    web.broadcast('state', { state: store.state });
  },
  async onReady() {
    await store.load(bridge);
    store.state = BridgeState.Ready;
    log(`loaded ${store.snapshot().conversations.length} conversations`);
    web.broadcast('resync', {});
  },
  onEvent(event) {
    store.apply(event);
    web.broadcast(event.event, event.data);
  },
});

web = createWebServer({
  port: args.port,
  token,
  publicDir: join(HERE, 'public'),
  store,
  bridge,
  log,
});

try {
  await web.listen();
} catch (error) {
  log(`cannot listen on 127.0.0.1:${args.port}: ${error.code}`);
  process.exit(1);
}

log(`endpoint: ${endpoint}`);
log(`client key: ${bridge.publicKey}`);
log(`add this URL to Rambox as a custom app: ${url}`);
bridge.start();

async function shutdown() {
  log('stopping');
  await bridge.stop();
  await web.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
