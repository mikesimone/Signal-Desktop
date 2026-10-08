// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { app } from 'electron';
import { userInfo } from 'node:os';

import { createLogger } from '../logging/log.std.ts';
import * as Errors from '../types/errors.std.ts';
import type { MainSQL } from '../sql/main.main.ts';
import { getExternalClientEndpoint } from '../externalClient/endpoint.node.ts';
import { ExternalClientServer } from '../externalClient/ExternalClientServer.node.ts';

const log = createLogger('externalClientMain');

// Owns the lifecycle of the local external-client bridge. The bridge is off
// unless the user enabled it; when off there is no listener and no endpoint
// on disk. See docs/external-client-architecture.md.
export class ExternalClientMain {
  readonly #sql: MainSQL;
  readonly #userDataPath: string;
  #server: ExternalClientServer | undefined;

  constructor({ sql, userDataPath }: { sql: MainSQL; userDataPath: string }) {
    this.#sql = sql;
    this.#userDataPath = userDataPath;
  }

  // Must be called only after SQL initialized successfully. The enabled flag
  // lives in the encrypted database rather than a plaintext config file so
  // that another process cannot switch the bridge on by editing a file.
  async refresh(): Promise<void> {
    let enabled: boolean;
    try {
      enabled = await this.#isEnabled();
    } catch (error) {
      log.error('refresh: failed to read setting', Errors.toLogFormat(error));
      enabled = false;
    }

    if (enabled) {
      await this.#start();
    } else {
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) {
      return;
    }
    try {
      await server.stop();
    } catch (error) {
      log.error('stop: failed', Errors.toLogFormat(error));
    }
  }

  async #isEnabled(): Promise<boolean> {
    // Unpackaged development builds can opt in without touching the database.
    if (!app.isPackaged && process.env.SIGNAL_ENABLE_EXTERNAL_CLIENTS === '1') {
      return true;
    }
    const item = await this.#sql.sqlRead(
      'getItemById',
      'externalClientsEnabled'
    );
    return item?.value === true;
  }

  async #start(): Promise<void> {
    if (this.#server) {
      return;
    }

    const endpoint = getExternalClientEndpoint({
      platform: process.platform,
      userDataPath: this.#userDataPath,
      username: userInfo().username,
      runtimeDir: process.env.XDG_RUNTIME_DIR,
    });
    const server = new ExternalClientServer({
      endpoint,
      getSignalVersion: () => app.getVersion(),
      log,
    });

    try {
      await server.start();
      this.#server = server;
      // Endpoint names are a hash, not user data; paths under userData are
      // redacted by the logger anyway.
      log.info(`start: listening on ${endpoint.kind} ${endpoint.path}`);
    } catch (error) {
      // Fail closed: an occupied or unsafe endpoint means no bridge, not a
      // retry loop or a fallback location.
      log.error('start: bridge not started', Errors.toLogFormat(error));
    }
  }
}
