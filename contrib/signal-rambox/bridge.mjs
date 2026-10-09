// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// Client for Signal Desktop's external-client bridge (protocol v1).
// No dependencies. Keeps one connection open, reconnects when Signal
// restarts, and reports its state through callbacks.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

const CLIENT_LABEL = 'signal-external-client/v1/client-auth';
const SERVER_LABEL = 'signal-external-client/v1/server-auth';

export const CAPABILITIES = [
  'conversations.read',
  'messages.read',
  'messages.send',
  'messages.markRead',
  'notifications.manage',
];

export const BridgeState = {
  // Signal is not running, or its bridge is off.
  Offline: 'offline',
  // Connected; waiting for the user to answer Signal's approval dialog.
  AwaitingApproval: 'awaitingApproval',
  // The user said no in Signal. Waits for retryApproval().
  Denied: 'denied',
  // Signal's key changed since it was pinned. Never retried automatically.
  KeyMismatch: 'keyMismatch',
  Ready: 'ready',
};

export function defaultUserData() {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA, 'Signal');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Signal');
  }
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'Signal'
  );
}

// Must match ts/externalClient/endpoint.node.ts in Signal Desktop.
export function endpointFor(userData) {
  const id = createHash('sha256')
    .update(realpathSync(userData))
    .update('\0')
    .update(userInfo().username)
    .digest('hex')
    .slice(0, 16);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\signal-desktop-external-client-${id}`;
  }
  const dir =
    process.platform === 'linux' && process.env.XDG_RUNTIME_DIR
      ? join(process.env.XDG_RUNTIME_DIR, 'signal-desktop')
      : join(realpathSync(userData), 'external-client');
  return join(dir, `${id}.sock`);
}

function writePrivate(file, text) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o600 });
}

// The key file holds this app's Ed25519 private key and the Signal key it
// pinned on first approval.
export function loadKey(file) {
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    return { ...saved, privateKey: createPrivateKey(saved.privateKeyPem) };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const saved = {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicKey: publicKey.export({ format: 'jwk' }).x,
    serverPublicKey: null,
  };
  writePrivate(file, JSON.stringify(saved, null, 2));
  return { ...saved, privateKey };
}

function saveKey(file, key) {
  const { privateKeyPem, publicKey, serverPublicKey } = key;
  writePrivate(
    file,
    JSON.stringify({ privateKeyPem, publicKey, serverPublicKey }, null, 2)
  );
}

function transcript(parts) {
  const chunks = [];
  parts.forEach((part, i) => {
    if (i > 0) {
      chunks.push(Buffer.from([0]));
    }
    chunks.push(typeof part === 'string' ? Buffer.from(part, 'utf8') : part);
  });
  return Buffer.concat(chunks);
}

function frame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(5);
  header.writeUInt8(1, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export class BridgeError extends Error {
  constructor(error) {
    super(`${error.code}: ${error.message}`);
    this.code = error.code;
    this.reason = error.reason;
  }
}

export class Bridge {
  #endpoint;
  #keyFile;
  #key;
  #displayName;
  #log;
  #socket;
  #waiting = new Map();
  #nextId = 0;
  #state = BridgeState.Offline;
  #retryTimer;
  #stopped = false;
  #nextRetryMs = 5000;
  #wantNotifications = false;
  #notificationsHeld = false;

  // onEvent({ event, seq, data }), onState(state), onReady()
  constructor({
    endpoint,
    keyFile,
    displayName,
    log,
    onEvent,
    onState,
    onReady,
  }) {
    this.#endpoint = endpoint;
    this.#keyFile = keyFile;
    this.#key = loadKey(keyFile);
    this.#displayName = displayName;
    this.#log = log;
    this.onEvent = onEvent;
    this.onState = onState;
    this.onReady = onReady;
  }

  get state() {
    return this.#state;
  }

  get publicKey() {
    return this.#key.publicKey;
  }

  start() {
    this.#stopped = false;
    this.#connect();
  }

  async stop() {
    this.#stopped = true;
    clearTimeout(this.#retryTimer);
    if (this.#socket && this.#state === BridgeState.Ready) {
      await Promise.race([
        this.call('session.disconnect'),
        new Promise(resolve => setTimeout(resolve, 1000)),
      ]);
    }
    this.#socket?.destroy();
  }

  // After the user denied approval, ask Signal again.
  retryApproval() {
    if (
      this.#state === BridgeState.Denied ||
      this.#state === BridgeState.Offline
    ) {
      clearTimeout(this.#retryTimer);
      this.#connect();
    }
  }

  // Hand Signal's message notifications to this app while it is connected
  // and the UI is open; give them back otherwise.
  async setNotificationsWanted(wanted) {
    this.#wantNotifications = wanted;
    await this.#syncNotifications();
  }

  async #syncNotifications() {
    if (this.#state !== BridgeState.Ready) {
      this.#notificationsHeld = false;
      return;
    }
    if (this.#wantNotifications === this.#notificationsHeld) {
      return;
    }
    const want = this.#wantNotifications;
    try {
      const result = await this.call('notifications.setHandled', {
        handled: want,
      });
      this.#notificationsHeld = result.handled;
      this.#log(`notifications held by this app: ${result.handled}`);
    } catch (error) {
      this.#log(`notifications.setHandled failed: ${error.message}`);
    }
  }

  call(method, params) {
    const socket = this.#socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(
        new BridgeError({ code: 'OFFLINE', message: 'Signal is not connected' })
      );
    }
    const id = `r${this.#nextId++}`;
    socket.write(
      frame(params === undefined ? { id, method } : { id, method, params })
    );
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, msg =>
        msg.error ? reject(new BridgeError(msg.error)) : resolve(msg.result)
      );
    });
  }

  #setState(state) {
    if (state !== this.#state) {
      this.#state = state;
      this.#log(`bridge: ${state}`);
      this.onState?.(state);
    }
  }

  #scheduleRetry(ms = 5000) {
    clearTimeout(this.#retryTimer);
    if (!this.#stopped) {
      this.#retryTimer = setTimeout(() => this.#connect(), ms);
    }
  }

  #connect() {
    if (this.#stopped) {
      return;
    }
    this.#socket?.destroy();
    const socket = connect(this.#endpoint);
    this.#socket = socket;
    let buffered = Buffer.alloc(0);

    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 5) {
        const len = buffered.readUInt32BE(1);
        if (buffered.length < 5 + len) {
          break;
        }
        const msg = JSON.parse(buffered.subarray(5, 5 + len).toString('utf8'));
        buffered = buffered.subarray(5 + len);
        if (msg.event) {
          this.#handleEvent(msg);
          continue;
        }
        const settle = this.#waiting.get(msg.id);
        this.#waiting.delete(msg.id);
        settle?.(msg);
      }
    });
    socket.on('error', () => {
      // 'close' follows and handles it.
    });
    socket.on('close', () => {
      if (this.#socket !== socket) {
        return;
      }
      for (const settle of this.#waiting.values()) {
        settle({ error: { code: 'OFFLINE', message: 'connection closed' } });
      }
      this.#waiting.clear();
      this.#notificationsHeld = false;
      if (
        this.#state !== BridgeState.Denied &&
        this.#state !== BridgeState.KeyMismatch
      ) {
        this.#setState(BridgeState.Offline);
        this.#scheduleRetry(this.#nextRetryMs);
        this.#nextRetryMs = 5000;
      }
    });
    socket.once('connect', () => {
      this.#handshake().catch(error => {
        this.#log(`handshake failed: ${error.message}`);
        if (error.code === 'PERMISSION_DENIED') {
          this.#setState(BridgeState.Denied);
        } else if (error.code === 'KEY_MISMATCH') {
          this.#setState(BridgeState.KeyMismatch);
        } else if (error.code === 'RATE_LIMITED') {
          // Signal is limiting approval prompts; don't ask again soon.
          this.#nextRetryMs = 60_000;
        }
        socket.destroy();
      });
    });
  }

  async #handshake() {
    const clientNonce = randomBytes(32);
    const hello = await this.call('session.hello', {
      protocol: 'signal-external-client',
      versions: [1],
      client: { name: 'signal-rambox', version: '1.0.0' },
      clientNonce: clientNonce.toString('base64url'),
    });

    const challenge = Buffer.from(hello.challenge, 'base64url');
    const serverKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: hello.server.publicKey },
      format: 'jwk',
    });
    const serverOk = verify(
      null,
      transcript([SERVER_LABEL, hello.sessionId, challenge, clientNonce]),
      serverKey,
      Buffer.from(hello.server.signature, 'base64url')
    );
    if (!serverOk) {
      throw new BridgeError({
        code: 'BAD_SERVER_SIGNATURE',
        message: 'Signal signature did not verify',
      });
    }
    if (
      this.#key.serverPublicKey &&
      this.#key.serverPublicKey !== hello.server.publicKey
    ) {
      throw new BridgeError({
        code: 'KEY_MISMATCH',
        message: 'Signal key changed since it was pinned',
      });
    }

    const signature = sign(
      null,
      transcript([CLIENT_LABEL, hello.sessionId, challenge]),
      this.#key.privateKey
    ).toString('base64url');

    // Signal answers at once if this key already holds every capability;
    // otherwise it shows its approval dialog and answers when the user does.
    this.#setState(BridgeState.AwaitingApproval);
    const granted = await this.call('authorization.request', {
      publicKey: this.#key.publicKey,
      signature,
      displayName: this.#displayName,
      capabilities: CAPABILITIES,
    });
    if (!this.#key.serverPublicKey) {
      this.#key.serverPublicKey = hello.server.publicKey;
      saveKey(this.#keyFile, this.#key);
    }
    this.#log(`authorized: ${granted.capabilities.join(', ')}`);

    await this.call('events.subscribe', {
      topics: ['conversations', 'messages'],
    });
    this.#setState(BridgeState.Ready);
    await this.onReady?.();
    await this.#syncNotifications();
  }

  async #handleEvent(msg) {
    if (msg.event === 'events.dropped') {
      // Signal stopped sending events because we fell behind: subscribe
      // again and let the app take a fresh snapshot.
      this.#notificationsHeld = false;
      try {
        await this.call('events.subscribe', {
          topics: ['conversations', 'messages'],
        });
        await this.onReady?.();
        await this.#syncNotifications();
      } catch (error) {
        this.#log(`resubscribe failed: ${error.message}`);
        this.#socket?.destroy();
      }
      return;
    }
    this.onEvent?.(msg);
  }
}
