// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';

import type { EndpointType } from './endpoint.node.ts';
import {
  cleanupEndpoint,
  prepareEndpoint,
  secureBoundEndpoint,
} from './endpoint.node.ts';
import type { ExternalClientLoggerType } from './ExternalClientSession.node.ts';
import type {
  ExternalClientAuthorityType,
  ExternalClientHostType,
} from './hostTypes.std.ts';
import { ExternalClientSession } from './ExternalClientSession.node.ts';
import type { LimitsType } from './protocol.std.ts';
import { LIMITS } from './protocol.std.ts';

// Transport for local external clients: a Unix domain socket or a Windows
// named pipe, never a network listener. This file knows nothing about
// Electron or Signal internals; everything Signal-specific is injected so it
// can be tested under plain Node.

export type ExternalClientServerOptionsType = Readonly<{
  endpoint: EndpointType;
  getSignalVersion: () => string;
  log: ExternalClientLoggerType;
  authority: ExternalClientAuthorityType;
  host: ExternalClientHostType;
  limits?: Partial<LimitsType>;
}>;

export class ExternalClientServer {
  readonly #endpoint: EndpointType;
  readonly #getSignalVersion: () => string;
  readonly #log: ExternalClientLoggerType;
  readonly #authority: ExternalClientAuthorityType;
  readonly #host: ExternalClientHostType;
  readonly #limits: LimitsType;
  readonly #sessions = new Set<ExternalClientSession>();
  #server: Server | undefined;

  constructor(options: ExternalClientServerOptionsType) {
    this.#endpoint = options.endpoint;
    this.#getSignalVersion = options.getSignalVersion;
    this.#log = options.log;
    this.#authority = options.authority;
    this.#host = options.host;
    this.#limits = { ...LIMITS, ...options.limits };
  }

  get isListening(): boolean {
    return this.#server?.listening ?? false;
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  async start(): Promise<void> {
    if (this.#server) {
      return;
    }

    await prepareEndpoint(this.#endpoint);

    const server = createServer(socket => this.#onConnection(socket));

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(
        {
          path: this.#endpoint.path,
          readableAll: false,
          writableAll: false,
        },
        () => {
          server.off('error', reject);
          resolve();
        }
      );
    });
    server.on('error', (error: NodeJS.ErrnoException) => {
      this.#log.error('server error', error.code);
    });

    this.#server = server;
    await secureBoundEndpoint(this.#endpoint);
    this.#log.info('external client bridge listening');
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) {
      return;
    }
    this.#server = undefined;

    for (const session of this.#sessions) {
      session.socket.destroy();
    }
    this.#sessions.clear();

    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
    await cleanupEndpoint(this.#endpoint);
    this.#log.info('external client bridge stopped');
  }

  // Closes every live session authenticated with this key. Called after the
  // grant has been deleted, so a reconnect fails authentication.
  revoke(publicKey: string): number {
    let closed = 0;
    for (const session of this.#sessions) {
      if (session.publicKey === publicKey) {
        session.close();
        closed += 1;
      }
    }
    return closed;
  }

  #onConnection(socket: Socket): void {
    if (this.#sessions.size >= this.#limits.maxConnections) {
      this.#log.warn('connection refused: too many connections');
      socket.destroy();
      return;
    }
    const session = new ExternalClientSession({
      socket,
      limits: this.#limits,
      log: this.#log,
      getSignalVersion: this.#getSignalVersion,
      authority: this.#authority,
      host: this.#host,
      onClosed: closed => {
        this.#sessions.delete(closed);
      },
    });
    this.#sessions.add(session);
    this.#log.info(`session ${session.logId}: client requested connection`);
  }
}
