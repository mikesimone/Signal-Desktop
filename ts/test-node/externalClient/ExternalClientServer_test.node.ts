// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EndpointType } from '../../externalClient/endpoint.node.ts';
import { getExternalClientEndpoint } from '../../externalClient/endpoint.node.ts';
import { ExternalClientServer } from '../../externalClient/ExternalClientServer.node.ts';
import {
  FrameDecoder,
  FrameKind,
  encodeJsonFrame,
} from '../../externalClient/framing.std.ts';
import type { LimitsType } from '../../externalClient/protocol.std.ts';
import {
  ALL_CAPABILITIES,
  ErrorCode,
  LIMITS,
  PROTOCOL_NAME,
} from '../../externalClient/protocol.std.ts';

const silentLog = { info: () => null, warn: () => null, error: () => null };

const HELLO = {
  id: 'h1',
  method: 'session.hello',
  params: {
    protocol: PROTOCOL_NAME,
    versions: [1],
    client: { name: 'fake-client', version: '0.0.1' },
  },
};

// Minimal external client used to drive the server like a real one would.
class FakeClient {
  readonly #decoder = new FrameDecoder({
    maxPayloadBytes: LIMITS.maxFrameBytes,
    allowedKinds: [FrameKind.Json],
  });
  readonly #messages = new Array<unknown>();
  readonly #waiters = new Array<() => void>();
  readonly socket: Socket;
  closed = false;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on('data', chunk => {
      for (const frame of this.#decoder.push(chunk)) {
        this.#messages.push(
          JSON.parse(new TextDecoder().decode(frame.payload))
        );
      }
      this.#wake();
    });
    socket.on('close', () => {
      this.closed = true;
      this.#wake();
    });
    socket.on('error', () => null);
  }

  static async connect(path: string): Promise<FakeClient> {
    const socket = connect(path);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return new FakeClient(socket);
  }

  send(value: unknown): void {
    this.socket.write(encodeJsonFrame(value));
  }

  async next(timeoutMs = 2000): Promise<unknown> {
    await this.#waitFor(() => this.#messages.length > 0, timeoutMs);
    return this.#messages.shift();
  }

  async waitClosed(timeoutMs = 2000): Promise<void> {
    await this.#waitFor(() => this.closed, timeoutMs);
  }

  get pending(): number {
    return this.#messages.length;
  }

  close(): void {
    this.socket.destroy();
  }

  async #waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('FakeClient: timed out');
      }
      // oxlint-disable-next-line no-await-in-loop
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, remaining);
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  #wake(): void {
    for (const waiter of this.#waiters.splice(0)) {
      waiter();
    }
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

describe('externalClient/ExternalClientServer', () => {
  if (process.platform === 'win32') {
    // Named-pipe behavior is covered by manual testing on Windows for now.
    return;
  }

  let tempDir: string;
  let endpoint: EndpointType;
  let server: ExternalClientServer;
  const clients = new Array<FakeClient>();

  async function startServer(limits?: Partial<LimitsType>): Promise<void> {
    server = new ExternalClientServer({
      endpoint,
      getSignalVersion: () => '8.33.0-test',
      log: silentLog,
      limits,
    });
    await server.start();
  }

  async function connectClient(): Promise<FakeClient> {
    const client = await FakeClient.connect(endpoint.path);
    clients.push(client);
    return client;
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'signal-ext-'));
    endpoint = getExternalClientEndpoint({
      platform: 'linux',
      userDataPath: join(tempDir, 'userData'),
      username: 'tester',
      runtimeDir: tempDir,
    });
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.close();
    }
    await server?.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('completes a hello handshake', async () => {
    await startServer();
    const client = await connectClient();
    client.send(HELLO);

    const response = (await client.next()) as {
      id: string;
      result: Record<string, unknown>;
    };
    assert.strictEqual(response.id, 'h1');
    assert.deepEqual(Object.keys(response.result).sort(), [
      'capabilities',
      'features',
      'protocol',
      'protocolVersion',
      'sessionId',
      'signalVersion',
    ]);
    assert.strictEqual(response.result.protocol, PROTOCOL_NAME);
    assert.strictEqual(response.result.protocolVersion, 1);
    assert.strictEqual(response.result.signalVersion, '8.33.0-test');
    assert.deepEqual(response.result.capabilities, ALL_CAPABILITIES);
    assert.deepEqual(response.result.features, {
      'authentication.required': true,
      'calling.available': false,
    });
    assert.match(String(response.result.sessionId), /^[0-9a-f]{32}$/);
  });

  it('creates a private directory and socket', async () => {
    await startServer();
    assert.strictEqual(endpoint.kind, 'socket');
    if (endpoint.kind !== 'socket') {
      return;
    }
    const permissions = (mode: number) => mode.toString(8).slice(-3);
    assert.strictEqual(
      permissions((await stat(endpoint.directory)).mode),
      '700'
    );
    assert.strictEqual(permissions((await stat(endpoint.path)).mode), '600');
  });

  it('writes nothing before the client speaks', async () => {
    await startServer();
    const client = await connectClient();
    await sleep(200);
    assert.strictEqual(client.pending, 0);
    assert.isFalse(client.closed);
  });

  it('requires hello first', async () => {
    await startServer();
    const client = await connectClient();
    client.send({ id: 'r1', method: 'conversations.list' });
    const response = (await client.next()) as { error: { code: string } };
    assert.strictEqual(response.error.code, ErrorCode.InvalidRequest);
    await client.waitClosed();
  });

  it('rejects an unsupported protocol version and closes', async () => {
    await startServer();
    const client = await connectClient();
    client.send({ ...HELLO, params: { ...HELLO.params, versions: [2, 3] } });
    const response = (await client.next()) as { error: { code: string } };
    assert.strictEqual(response.error.code, ErrorCode.UnsupportedVersion);
    await client.waitClosed();
  });

  it('rejects a malformed hello and closes', async () => {
    await startServer();
    const client = await connectClient();
    client.send({ ...HELLO, params: { protocol: PROTOCOL_NAME } });
    const response = (await client.next()) as { error: { code: string } };
    assert.strictEqual(response.error.code, ErrorCode.InvalidRequest);
    await client.waitClosed();
  });

  it('closes on an oversized frame without buffering it', async () => {
    await startServer();
    const client = await connectClient();
    const header = new Uint8Array(5);
    new DataView(header.buffer).setUint8(0, FrameKind.Json);
    new DataView(header.buffer).setUint32(1, LIMITS.maxFrameBytes + 1, false);
    client.socket.write(header);
    const response = (await client.next()) as { error: { code: string } };
    assert.strictEqual(response.error.code, ErrorCode.InvalidRequest);
    await client.waitClosed();
  });

  it('closes on non-JSON and invalid UTF-8 payloads', async () => {
    await startServer();
    for (const payload of [
      new TextEncoder().encode('{not json'),
      new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      const client = await connectClient();
      const frame = new Uint8Array(5 + payload.byteLength);
      new DataView(frame.buffer).setUint8(0, FrameKind.Json);
      new DataView(frame.buffer).setUint32(1, payload.byteLength, false);
      frame.set(payload, 5);
      client.socket.write(frame);
      // oxlint-disable-next-line no-await-in-loop
      const response = (await client.next()) as { error: { code: string } };
      assert.strictEqual(response.error.code, ErrorCode.InvalidRequest);
      // oxlint-disable-next-line no-await-in-loop
      await client.waitClosed();
    }
  });

  it('refuses unknown methods, including internal IPC names', async () => {
    await startServer();
    const client = await connectClient();
    client.send(HELLO);
    await client.next();

    for (const method of [
      'conversations.list',
      'sql-channel:read',
      'executeSQL',
      'dispatchReduxAction',
      '__proto__',
      'constructor',
    ]) {
      client.send({ id: 'x', method, params: {} });
      // oxlint-disable-next-line no-await-in-loop
      const response = (await client.next()) as { error: { code: string } };
      assert.strictEqual(response.error.code, ErrorCode.UnsupportedMethod);
    }
    assert.isFalse(client.closed);
  });

  it('rejects a second hello', async () => {
    await startServer();
    const client = await connectClient();
    client.send(HELLO);
    await client.next();
    client.send({ ...HELLO, id: 'h2' });
    const response = (await client.next()) as { error: { code: string } };
    assert.strictEqual(response.error.code, ErrorCode.InvalidRequest);
    await client.waitClosed();
  });

  it('acknowledges disconnect and closes', async () => {
    await startServer();
    const client = await connectClient();
    client.send(HELLO);
    await client.next();
    client.send({ id: 'd1', method: 'session.disconnect' });
    assert.deepEqual(await client.next(), { id: 'd1', result: {} });
    await client.waitClosed();
  });

  it('times out clients that never say hello', async () => {
    await startServer({ handshakeTimeoutMs: 100 });
    const client = await connectClient();
    await client.waitClosed();
    assert.strictEqual(client.pending, 0);
  });

  it('limits concurrent connections', async () => {
    await startServer({ maxConnections: 2 });
    await connectClient();
    await connectClient();
    await sleep(50);
    const third = await connectClient();
    await third.waitClosed();
    assert.strictEqual(server.sessionCount, 2);
  });

  it('removes the socket on stop and can restart', async () => {
    await startServer();
    await server.stop();
    try {
      await stat(endpoint.path);
      assert.fail('socket should have been removed');
    } catch (error) {
      assert.strictEqual(error.code, 'ENOENT');
    }

    await startServer();
    const client = await connectClient();
    client.send(HELLO);
    assert.include(Object.keys((await client.next()) as object), 'result');
  });

  it('closes live sessions on stop', async () => {
    await startServer();
    const client = await connectClient();
    client.send(HELLO);
    await client.next();
    await server.stop();
    await client.waitClosed();
  });

  it('refuses to replace a file that is not its socket', async () => {
    if (endpoint.kind !== 'socket') {
      return;
    }
    await startServer();
    await server.stop();
    await writeFile(endpoint.path, 'not a socket');
    server = new ExternalClientServer({
      endpoint,
      getSignalVersion: () => 'x',
      log: silentLog,
    });
    let threw = false;
    try {
      await server.start();
    } catch {
      threw = true;
    }
    assert.isTrue(threw);
    assert.isFalse(server.isListening);
  });
});
