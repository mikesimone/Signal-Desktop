// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// End-to-end tests: the real helper process against FakeBridge.
//   node --test contrib/signal-rambox/test/

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FakeBridge, makeConversation, makeMessage } from './fake-bridge.mjs';

const HELPER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'signal-rambox.mjs'
);

function waitFor(check, timeoutMs = 10_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = check();
      if (value) {
        resolve(value);
      } else if (Date.now() - started > timeoutMs) {
        reject(new Error('timed out'));
      } else {
        setTimeout(tick, 20);
      }
    };
    tick();
  });
}

// node:http, not fetch, so tests can set Host and Origin freely.
function http(port, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: { host: `127.0.0.1:${port}`, ...headers },
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, text });
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

const json = { 'content-type': 'application/json' };

// A Unix socket on macOS and Linux, a named pipe on Windows.
function bridgePath(dir) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\signal-rambox-test-${process.pid}-${Math.random()}`
    : join(dir, 'bridge.sock');
}

async function startHelper({ socketPath, port }) {
  const config = mkdtempSync(join(tmpdir(), 'srb-'));
  const child = spawn(
    process.execPath,
    [
      HELPER,
      '--endpoint',
      socketPath,
      '--port',
      String(port),
      '--config',
      config,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let output = '';
  child.stdout.on('data', d => {
    output += d;
  });
  child.stderr.on('data', d => {
    output += d;
  });
  const url = await waitFor(
    () => output.match(/custom app: (http:\/\/\S+)/)?.[1]
  );
  const token = new URL(url).pathname.split('/')[1];
  return {
    child,
    token,
    config,
    output: () => output,
    async stop() {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
      rmSync(config, { recursive: true, force: true });
    },
  };
}

// Opens the event stream and collects events until closed.
function openEvents(port, token) {
  const events = [];
  let req;
  const opened = new Promise((resolve, reject) => {
    req = request(
      {
        host: '127.0.0.1',
        port,
        path: `/${token}/api/events`,
        headers: { host: `127.0.0.1:${port}` },
      },
      res => {
        let buffered = '';
        res.on('data', chunk => {
          buffered += chunk;
          let end;
          while ((end = buffered.indexOf('\n\n')) !== -1) {
            const block = buffered.slice(0, end);
            buffered = buffered.slice(end + 2);
            const type = block.match(/^event: (.*)$/m)?.[1];
            const data = block.match(/^data: (.*)$/m)?.[1];
            if (type) {
              events.push({ type, data: JSON.parse(data) });
            }
          }
        });
        resolve();
      }
    );
    req.on('error', reject);
    req.end();
  });
  return { events, opened, close: () => req.destroy() };
}

describe('signal-rambox', () => {
  const dir = mkdtempSync(join(tmpdir(), 'srb-sock-'));
  const socketPath = bridgePath(dir);
  const port = 47_900 + Math.floor(Math.random() * 500);
  const bridge = new FakeBridge();
  const alice = makeConversation({ title: 'Alice', unreadCount: 2 });
  const group = makeConversation({
    title: 'Book club',
    type: 'group',
    memberCount: 4,
  });
  let helper;

  before(async () => {
    bridge.conversations = [alice, group];
    bridge.messages.set(alice.id, [makeMessage(alice.id, { body: 'hi' })]);
    bridge.sendRefusals.set(group.id, 'announcementOnly');
    await bridge.listen(socketPath);
    helper = await startHelper({ socketPath, port });
    await waitFor(() => /loaded 2 conversations/.test(helper.output()));
  });

  after(async () => {
    await helper.stop();
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks for exactly the capabilities it uses', () => {
    const req = bridge.calls.find(c => c.method === 'authorization.request');
    assert.deepEqual(req.params.capabilities.sort(), [
      'conversations.read',
      'messages.markRead',
      'messages.read',
      'messages.send',
      'notifications.manage',
    ]);
    assert.equal(req.params.displayName, 'Rambox (signal-rambox)');
  });

  it('serves the conversation snapshot', async () => {
    const res = await http(port, { path: `/${helper.token}/api/state` });
    assert.equal(res.status, 200);
    const state = JSON.parse(res.text);
    assert.equal(state.state, 'ready');
    assert.deepEqual(
      state.conversations.map(c => c.title),
      ['Alice', 'Book club']
    );
  });

  it('serves the page with a strict content security policy', async () => {
    const res = await http(port, { path: `/${helper.token}/` });
    assert.equal(res.status, 200);
    assert.match(res.text, /<title>Signal<\/title>/);
    assert.match(res.headers['content-security-policy'], /default-src 'none'/);
    assert.match(
      res.headers['content-security-policy'],
      /frame-ancestors 'none'/
    );
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  it('redirects /<token> to /<token>/', async () => {
    const res = await http(port, { path: `/${helper.token}` });
    assert.equal(res.status, 308);
    assert.equal(res.headers.location, `/${helper.token}/`);
  });

  describe('refuses requests that could come from elsewhere', () => {
    it('without the token', async () => {
      assert.equal((await http(port, { path: '/' })).status, 404);
      assert.equal((await http(port, { path: '/api/state' })).status, 404);
      const wrong = `${helper.token.slice(0, -1)}x`;
      assert.equal(
        (await http(port, { path: `/${wrong}/api/state` })).status,
        404
      );
    });

    it('with another Host (DNS rebinding)', async () => {
      const res = await http(port, {
        path: `/${helper.token}/api/state`,
        headers: { host: `evil.example:${port}` },
      });
      assert.equal(res.status, 421);
    });

    it('from another origin', async () => {
      const res = await http(port, {
        path: `/${helper.token}/api/state`,
        headers: { origin: 'https://evil.example' },
      });
      assert.equal(res.status, 403);
    });

    it('marked cross-site by the browser', async () => {
      const res = await http(port, {
        path: `/${helper.token}/api/state`,
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      assert.equal(res.status, 403);
    });

    it('POST without a JSON content type (no simple CORS requests)', async () => {
      const res = await http(port, {
        method: 'POST',
        path: `/${helper.token}/api/send`,
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ conversationId: alice.id, body: 'x' }),
      });
      assert.equal(res.status, 415);
      assert.ok(!bridge.calls.some(c => c.method === 'messages.sendText'));
    });

    it('other methods', async () => {
      const res = await http(port, {
        method: 'PUT',
        path: `/${helper.token}/api/state`,
      });
      assert.equal(res.status, 405);
    });
  });

  it('allows same-origin requests from the page', async () => {
    const res = await http(port, {
      path: `/${helper.token}/api/state`,
      headers: {
        origin: `http://127.0.0.1:${port}`,
        'sec-fetch-site': 'same-origin',
      },
    });
    assert.equal(res.status, 200);
  });

  it('lists messages', async () => {
    const res = await http(port, {
      path: `/${helper.token}/api/messages?conversationId=${alice.id}`,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(
      JSON.parse(res.text).messages.map(m => m.body),
      ['hi']
    );
  });

  it('sends, and reports why Signal refused', async () => {
    const ok = await http(port, {
      method: 'POST',
      path: `/${helper.token}/api/send`,
      headers: json,
      body: { conversationId: alice.id, body: 'hello there' },
    });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.text).message.body, 'hello there');

    const refused = await http(port, {
      method: 'POST',
      path: `/${helper.token}/api/send`,
      headers: json,
      body: { conversationId: group.id, body: 'hi all' },
    });
    assert.equal(refused.status, 400);
    assert.equal(JSON.parse(refused.text).error.reason, 'announcementOnly');
  });

  it('marks read', async () => {
    const res = await http(port, {
      method: 'POST',
      path: `/${helper.token}/api/markRead`,
      headers: json,
      body: { conversationId: alice.id, upToMessageId: 'abc' },
    });
    assert.equal(res.status, 200);
    const call = bridge.calls.findLast(c => c.method === 'messages.markRead');
    assert.deepEqual(call.params, {
      conversationId: alice.id,
      upToMessageId: 'abc',
    });
  });

  it('takes notifications only while the page is open, and relays events', async () => {
    assert.equal(bridge.notificationsHandled, false);
    const stream = openEvents(port, helper.token);
    await stream.opened;
    await waitFor(() => bridge.notificationsHandled === true);

    const incoming = makeMessage(alice.id, { body: 'are you there?' });
    bridge.emit('message.added', incoming);
    bridge.emit('conversation.updated', { ...alice, unreadCount: 3 });
    await waitFor(() => stream.events.some(e => e.type === 'message.added'));
    const added = stream.events.find(e => e.type === 'message.added');
    assert.equal(added.data.body, 'are you there?');

    await waitFor(() =>
      stream.events.some(e => e.type === 'conversation.updated')
    );
    const state = JSON.parse(
      (await http(port, { path: `/${helper.token}/api/state` })).text
    );
    assert.equal(
      state.conversations.find(c => c.id === alice.id).unreadCount,
      3
    );

    stream.close();
    await waitFor(() => bridge.notificationsHandled === false);
  });

  it('resubscribes and resyncs after events.dropped', async () => {
    const stream = openEvents(port, helper.token);
    await stream.opened;
    const before = bridge.calls.filter(
      c => c.method === 'events.subscribe'
    ).length;
    bridge.emit('events.dropped', {});
    await waitFor(() => stream.events.some(e => e.type === 'resync'));
    const after = bridge.calls.filter(
      c => c.method === 'events.subscribe'
    ).length;
    assert.equal(after, before + 1);
    stream.close();
  });
});

describe('signal-rambox when the user says no', () => {
  const dir = mkdtempSync(join(tmpdir(), 'srb-sock-'));
  const socketPath = bridgePath(dir);
  const port = 48_500 + Math.floor(Math.random() * 500);
  const bridge = new FakeBridge();
  let helper;

  before(async () => {
    bridge.approval = 'deny';
    await bridge.listen(socketPath);
    helper = await startHelper({ socketPath, port });
  });

  after(async () => {
    await helper.stop();
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stops asking, then asks again when the page says so', async () => {
    await waitFor(() => /bridge: denied/.test(helper.output()));
    const asked = () =>
      bridge.calls.filter(c => c.method === 'authorization.request').length;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(asked(), 1);

    bridge.approval = 'approve';
    const res = await http(port, {
      method: 'POST',
      path: `/${helper.token}/api/retry`,
      headers: json,
      body: {},
    });
    assert.equal(res.status, 200);
    await waitFor(() => /bridge: ready/.test(helper.output()));
    assert.equal(asked(), 2);
  });
});
