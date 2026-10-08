// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';

import type { LoggerType } from '../types/Logging.std.ts';
import { safeParseUnknown } from '../util/schemas.std.ts';
import { FrameError } from './errors.std.ts';
import { FrameDecoder, FrameKind, encodeJsonFrame } from './framing.std.ts';
import type {
  ErrorCodeType,
  HelloResultType,
  LimitsType,
  RequestEnvelopeType,
  ResponseType,
} from './protocol.std.ts';
import {
  ALL_CAPABILITIES,
  ErrorCode,
  Method,
  PROTOCOL_NAME,
  helloParamsSchema,
  makeError,
  negotiateVersion,
  requestEnvelopeSchema,
} from './protocol.std.ts';

// One connected external client. Owns the per-connection state machine:
// awaiting hello, greeted, closed. Authentication and capability checks will
// be added here (see docs/external-client-implementation-plan.md).

export type ExternalClientLoggerType = Pick<
  LoggerType,
  'info' | 'warn' | 'error'
>;

export type ExternalClientSessionOptionsType = Readonly<{
  socket: Socket;
  limits: LimitsType;
  log: ExternalClientLoggerType;
  getSignalVersion: () => string;
  onClosed: (session: ExternalClientSession) => void;
}>;

const SessionState = {
  AwaitingHello: 'AwaitingHello',
  Greeted: 'Greeted',
  Closed: 'Closed',
} as const;
type SessionStateType = (typeof SessionState)[keyof typeof SessionState];

const CLOSE_GRACE_MS = 1000;

const utf8 = new TextDecoder('utf-8', { fatal: true });

export class ExternalClientSession {
  readonly id = randomBytes(16).toString('hex');
  readonly socket: Socket;
  readonly #limits: LimitsType;
  readonly #log: ExternalClientLoggerType;
  readonly #getSignalVersion: () => string;
  readonly #onClosed: (session: ExternalClientSession) => void;
  readonly #decoder: FrameDecoder;
  readonly #handshakeTimer: NodeJS.Timeout;
  #state: SessionStateType = SessionState.AwaitingHello;

  constructor(options: ExternalClientSessionOptionsType) {
    this.socket = options.socket;
    this.#limits = options.limits;
    this.#log = options.log;
    this.#getSignalVersion = options.getSignalVersion;
    this.#onClosed = options.onClosed;
    this.#decoder = new FrameDecoder({
      maxPayloadBytes: this.#limits.maxFrameBytes,
      allowedKinds: [FrameKind.Json],
    });
    this.#handshakeTimer = setTimeout(() => {
      this.#log.warn(`session ${this.logId}: handshake timed out`);
      this.close();
    }, this.#limits.handshakeTimeoutMs);

    this.socket.on('data', chunk => this.#onData(chunk));
    this.socket.on('error', (error: NodeJS.ErrnoException) => {
      this.#log.warn(`session ${this.logId}: socket error`, error.code);
    });
    this.socket.on('close', () => this.#handleClosed());
  }

  get logId(): string {
    return this.id.slice(0, 8);
  }

  close(): void {
    if (this.#state === SessionState.Closed) {
      return;
    }
    this.#state = SessionState.Closed;
    clearTimeout(this.#handshakeTimer);
    this.socket.end();
    // Do not wait long on a client that is not reading.
    setTimeout(() => this.socket.destroy(), CLOSE_GRACE_MS).unref();
  }

  #isClosed(): boolean {
    return this.#state === SessionState.Closed;
  }

  #handleClosed(): void {
    this.#state = SessionState.Closed;
    clearTimeout(this.#handshakeTimer);
    this.#onClosed(this);
  }

  #onData(chunk: Uint8Array<ArrayBuffer>): void {
    if (this.#state === SessionState.Closed) {
      return;
    }

    let frames;
    try {
      frames = this.#decoder.push(chunk);
    } catch (error) {
      if (!(error instanceof FrameError)) {
        throw error;
      }
      this.#reject(null, ErrorCode.InvalidRequest, 'Malformed frame');
      return;
    }

    for (const frame of frames) {
      if (this.#isClosed()) {
        return;
      }
      this.#onFrame(frame.payload);
    }
  }

  #onFrame(payload: Uint8Array<ArrayBuffer>): void {
    let json: unknown;
    try {
      json = JSON.parse(utf8.decode(payload));
    } catch {
      this.#reject(null, ErrorCode.InvalidRequest, 'Malformed message');
      return;
    }

    const parsed = safeParseUnknown(requestEnvelopeSchema, json);
    if (!parsed.success) {
      this.#reject(null, ErrorCode.InvalidRequest, 'Malformed request');
      return;
    }

    this.#onRequest(parsed.data);
  }

  #onRequest(request: RequestEnvelopeType): void {
    if (this.#state === SessionState.AwaitingHello) {
      if (request.method !== Method.Hello) {
        this.#reject(request.id, ErrorCode.InvalidRequest, 'Expected hello');
        return;
      }
      this.#onHello(request);
      return;
    }

    switch (request.method) {
      case Method.Hello:
        this.#reject(request.id, ErrorCode.InvalidRequest, 'Already greeted');
        return;
      case Method.Disconnect:
        this.#send({ id: request.id, result: {} });
        this.#log.info(`session ${this.logId}: client disconnected`);
        this.close();
        return;
      default:
        this.#send(
          makeError(
            request.id,
            ErrorCode.UnsupportedMethod,
            'Unsupported method'
          )
        );
    }
  }

  #onHello(request: RequestEnvelopeType): void {
    const parsed = safeParseUnknown(helloParamsSchema, request.params);
    if (!parsed.success) {
      this.#reject(request.id, ErrorCode.InvalidRequest, 'Invalid hello');
      return;
    }

    const version = negotiateVersion(parsed.data.versions);
    if (version === undefined) {
      this.#log.info(`session ${this.logId}: protocol mismatch`);
      this.#reject(
        request.id,
        ErrorCode.UnsupportedVersion,
        'No common protocol version'
      );
      return;
    }

    clearTimeout(this.#handshakeTimer);
    this.#state = SessionState.Greeted;
    this.#log.info(
      `session ${this.logId}: hello accepted, protocol v${version}`
    );

    const result: HelloResultType = {
      protocol: PROTOCOL_NAME,
      protocolVersion: version,
      signalVersion: this.#getSignalVersion(),
      sessionId: this.id,
      capabilities: ALL_CAPABILITIES,
      features: {
        'authentication.required': true,
        'calling.available': false,
      },
    };
    this.#send({ id: request.id, result });
  }

  // Protocol violations are answered once and then the connection is closed.
  // Nothing is ever written before the client has written to the connection,
  // so a peer that can only open the endpoint for reading learns nothing.
  #reject(id: string | null, code: ErrorCodeType, message: string): void {
    this.#log.warn(`session ${this.logId}: rejected (${code})`);
    this.#send(makeError(id, code, message));
    this.close();
  }

  #send(response: ResponseType): void {
    if (this.socket.destroyed || !this.socket.writable) {
      return;
    }
    this.socket.write(encodeJsonFrame(response));
    // A client that does not read must not grow our memory without bound.
    if (this.socket.writableLength > 2 * this.#limits.maxFrameBytes) {
      this.#log.warn(`session ${this.logId}: client not reading`);
      this.socket.destroy();
    }
  }
}
