// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// End-to-end tests: the real helper process against FakeBridge.
//   node --test contrib/signal-rambox/test/

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
        headers: {
          host: `127.0.0.1:${port}`,
          ...(Buffer.isBuffer(body)
            ? { 'content-length': String(body.length) }
            : {}),
          ...headers,
        },
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
      req.write(
        typeof body === 'string' || Buffer.isBuffer(body)
          ? body
          : JSON.stringify(body)
      );
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

async function startHelper({ socketPath, port, extraArgs = [] }) {
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
      ...extraArgs,
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
  await waitFor(() => /serving https?:\/\//.test(output));
  const token = readFileSync(join(config, 'token'), 'utf8').trim();
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
    bridge.attachments.set('m1:0', {
      contentType: 'video/mp4',
      bytes: Buffer.alloc(1_200_000, 7),
    });
    bridge.attachments.set('m1:1', {
      contentType: 'text/html',
      bytes: Buffer.from('<script>alert(1)</script>'),
    });
    bridge.avatars.set(alice.id, {
      avatarVersion: 'v1',
      contentType: 'image/png',
      data: Buffer.from('fake png').toString('base64'),
    });
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
      'attachments.read',
      'conversations.read',
      'messages.markRead',
      'messages.react',
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

  it('replies with a quote', async () => {
    const res = await http(port, {
      method: 'POST',
      path: `/${helper.token}/api/send`,
      headers: json,
      body: { conversationId: alice.id, body: 'yes', quoteMessageId: 'q1' },
    });
    assert.equal(res.status, 200);
    const call = bridge.calls.findLast(c => c.method === 'messages.sendText');
    assert.deepEqual(call.params, {
      conversationId: alice.id,
      body: 'yes',
      quoteMessageId: 'q1',
    });
  });

  it('reports what Signal granted', async () => {
    const res = await http(port, { path: `/${helper.token}/api/state` });
    assert.ok(JSON.parse(res.text).capabilities.includes('messages.react'));
  });

  it('serves photos, cached, and 404 without one', async () => {
    const path = `/${helper.token}/api/avatar?conversationId=${alice.id}&v=v1`;
    const first = await http(port, { path });
    assert.equal(first.status, 200);
    assert.equal(first.headers['content-type'], 'image/png');
    assert.equal(first.text, 'fake png');
    assert.match(first.headers['cache-control'], /immutable/);
    await http(port, { path });
    assert.equal(
      bridge.calls.filter(c => c.method === 'conversations.getAvatar').length,
      1
    );
    const none = await http(port, {
      path: `/${helper.token}/api/avatar?conversationId=${group.id}&v=x`,
    });
    assert.equal(none.status, 404);
    const unauthorized = await http(port, {
      path: `/wrong/api/avatar?conversationId=${alice.id}&v=v1`,
    });
    assert.equal(unauthorized.status, 404);
  });

  it('reacts, and serves the quick-reaction bar', async () => {
    const bar = await http(port, { path: `/${helper.token}/api/reactions` });
    assert.deepEqual(JSON.parse(bar.text).emoji[0], '🔥');
    const res = await http(port, {
      method: 'POST',
      path: `/${helper.token}/api/react`,
      headers: json,
      body: { messageId: 'm1', emoji: '👍', remove: true },
    });
    assert.equal(res.status, 200);
    const call = bridge.calls.findLast(c => c.method === 'messages.react');
    assert.deepEqual(call.params, {
      messageId: 'm1',
      emoji: '👍',
      remove: true,
    });
  });

  it("serves Signal's full emoji list and recently used emoji", async () => {
    const catalog = await http(port, { path: `/${helper.token}/api/emoji` });
    assert.equal(catalog.status, 200);
    assert.deepEqual(JSON.parse(catalog.text).categories[1].emoji[0], [
      '🦃',
      'turkey',
    ]);
    bridge.recentEmoji = ['😂'];
    const bar = await http(port, { path: `/${helper.token}/api/reactions` });
    assert.deepEqual(JSON.parse(bar.text).recent, ['😂']);
    const used = await http(port, {
      method: 'POST',
      path: `/${helper.token}/api/emojiUsed`,
      headers: json,
      body: { emoji: '🦃' },
    });
    assert.equal(used.status, 200);
    assert.deepEqual(bridge.recentEmoji, ['🦃', '😂']);
  });

  it("serves Signal's emoji font", async () => {
    const res = await http(port, {
      path: `/${helper.token}/fonts/emoji.woff2`,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'font/woff2');
    assert.match(res.headers['content-security-policy'], /font-src 'self'/);
  });

  it('streams attachments in chunks, with ranges', async () => {
    const base = `/${helper.token}/api/attachment?messageId=m1&index=0&name=clip.mp4`;
    const whole = await http(port, { path: base });
    assert.equal(whole.status, 200);
    assert.equal(whole.headers['content-type'], 'video/mp4');
    assert.equal(whole.headers['content-length'], '1200000');
    assert.equal(whole.headers['accept-ranges'], 'bytes');
    const part = await http(port, {
      path: base,
      headers: { range: 'bytes=1199990-' },
    });
    assert.equal(part.status, 206);
    assert.equal(
      part.headers['content-range'],
      'bytes 1199990-1199999/1200000'
    );
    assert.equal(part.headers['content-length'], '10');
    const reads = bridge.calls.filter(c => c.method === 'attachments.read');
    assert.ok(reads.every(c => c.params.length <= 512 * 1024));
  });

  it('never serves a chat file as a page', async () => {
    const res = await http(port, {
      path: `/${helper.token}/api/attachment?messageId=m1&index=1&name=x.html`,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.match(res.headers['content-disposition'], /^attachment;/);
  });

  it('serves thumbnails and asks Signal to download', async () => {
    const thumb = await http(port, {
      path: `/${helper.token}/api/thumbnail?messageId=m1&index=0`,
    });
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers['content-type'], 'image/webp');
    const missing = await http(port, {
      path: `/${helper.token}/api/attachment?messageId=nope&index=0`,
    });
    assert.equal(missing.status, 404);
    const download = await http(port, {
      method: 'POST',
      path: `/${helper.token}/api/download`,
      headers: json,
      body: { messageId: 'm1' },
    });
    assert.equal(download.status, 200);
  });

  it('asks for link preview images by preview index', async () => {
    const thumb = await http(port, {
      path: `/${helper.token}/api/thumbnail?messageId=m1&preview=0`,
    });
    assert.equal(thumb.status, 200);
    const call = bridge.calls.findLast(
      c => c.method === 'attachments.getThumbnail'
    );
    assert.deepEqual(call.params, { messageId: 'm1', preview: 0 });
  });

  it('asks for previews as wide as the page draws them, within limits', async () => {
    for (const [asked, sent] of [
      ['480', 480],
      ['99999', 1600],
      ['x', undefined],
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      await http(port, {
        path: `/${helper.token}/api/thumbnail?messageId=m1&index=0&width=${asked}`,
      });
      const call = bridge.calls.findLast(
        c => c.method === 'attachments.getThumbnail'
      );
      assert.equal(call.params.width, sent);
    }
  });

  it('edits and deletes', async () => {
    const edit = await http(port, {
      method: 'POST',
      path: `/${helper.token}/api/edit`,
      headers: json,
      body: { messageId: 'm1', body: 'fixed' },
    });
    assert.equal(edit.status, 200);
    assert.deepEqual(
      bridge.calls.findLast(c => c.method === 'messages.edit').params,
      { messageId: 'm1', body: 'fixed' }
    );
    for (const forEveryone of [true, undefined]) {
      // oxlint-disable-next-line no-await-in-loop
      const res = await http(port, {
        method: 'POST',
        path: `/${helper.token}/api/delete`,
        headers: json,
        body: { messageId: 'm1', forEveryone },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(
        bridge.calls.findLast(c => c.method === 'messages.delete').params,
        { messageId: 'm1', forEveryone: forEveryone === true }
      );
    }
  });

  it('uploads a file in chunks and sends it', async () => {
    const bytes = Buffer.alloc(1_200_000, 7);
    const res = await http(port, {
      method: 'POST',
      path: `/${helper.token}/api/upload?contentType=image%2Fpng&name=shot.png`,
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    assert.equal(res.status, 200);
    const { uploadId } = JSON.parse(res.text);
    const upload = bridge.uploads.get(uploadId);
    assert.equal(upload.size, bytes.length);
    assert.equal(upload.fileName, 'shot.png');
    assert.ok(Buffer.concat(upload.bytes).equals(bytes));
    assert.ok(upload.bytes.every(chunk => chunk.length <= 512 * 1024));

    const sent = await http(port, {
      method: 'POST',
      path: `/${helper.token}/api/send`,
      headers: json,
      body: { conversationId: 'c1', body: '', attachmentUploadIds: [uploadId] },
    });
    assert.equal(sent.status, 200);
    assert.deepEqual(
      bridge.calls.findLast(c => c.method === 'messages.sendText').params,
      { conversationId: 'c1', body: '', attachmentUploadIds: [uploadId] }
    );
  });

  it('takes uploads only as application/octet-stream', async () => {
    const res = await http(port, {
      method: 'POST',
      path: `/${helper.token}/api/upload?contentType=image%2Fpng`,
      headers: { 'Content-Type': 'text/plain' },
      body: Buffer.from('x'),
    });
    assert.equal(res.status, 415);
    const elsewhere = await http(port, {
      method: 'POST',
      path: `/${helper.token}/api/send`,
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('{}'),
    });
    assert.equal(elsewhere.status, 415);
  });

  it('forwards to any number of chats and reports each', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `c${i}`);
    bridge.sendRefusals.set('c3', 'blocked');
    const res = await http(port, {
      method: 'POST',
      path: `/${helper.token}/api/forward`,
      headers: json,
      body: { messageId: 'm1', conversationIds: ids },
    });
    bridge.sendRefusals.delete('c3');
    assert.equal(res.status, 200);
    const { results } = JSON.parse(res.text);
    assert.equal(results.length, 40);
    assert.deepEqual(results[3], {
      conversationId: 'c3',
      ok: false,
      reason: 'blocked',
    });
  });

  it('sends a poll to many chats and votes', async () => {
    const ids = ['p0', 'p1', 'p2'];
    bridge.sendRefusals.set('p1', 'pollsNotSupported');
    const res = await http(port, {
      method: 'POST',
      path: `/${helper.token}/api/pollSend`,
      headers: json,
      body: {
        conversationIds: ids,
        question: 'Lunch?',
        options: ['Tacos', 'Pho'],
        allowMultiple: 'yes',
      },
    });
    bridge.sendRefusals.delete('p1');
    assert.equal(res.status, 200);
    const { results } = JSON.parse(res.text);
    assert.deepEqual(
      results.map(result => result.ok),
      [true, false, true]
    );
    const send = bridge.calls.findLast(c => c.method === 'polls.send');
    // Only a real true allows several answers.
    assert.equal(send.params.allowMultiple, false);

    const vote = await http(port, {
      method: 'POST',
      path: `/${helper.token}/api/pollVote`,
      headers: json,
      body: { messageId: 'm1', optionIndexes: [1] },
    });
    assert.equal(vote.status, 200);
    assert.deepEqual(
      bridge.calls.findLast(c => c.method === 'polls.vote').params,
      { messageId: 'm1', optionIndexes: [1] }
    );
  });

  it('lists group members and sends mentions', async () => {
    bridge.members.set('g1', [
      { conversationId: 'c-bill', author: { title: 'Bill Smith' } },
    ]);
    const list = await http(port, {
      path: `/${helper.token}/api/members?conversationId=g1`,
    });
    assert.equal(list.status, 200);
    assert.equal(JSON.parse(list.text).members[0].conversationId, 'c-bill');

    const mentions = [{ start: 3, conversationId: 'c-bill' }];
    const res = await http(port, {
      method: 'POST',
      path: `/${helper.token}/api/send`,
      headers: json,
      body: { conversationId: 'g1', body: 'hi \uFFFC', mentions },
    });
    assert.equal(res.status, 200);
    const call = bridge.calls.findLast(c => c.method === 'messages.sendText');
    assert.deepEqual(call.params.mentions, mentions);
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

describe('signal-rambox behind a reverse proxy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'srb-sock-'));
  const socketPath = bridgePath(dir);
  const port = 48_500 + Math.floor(Math.random() * 500);
  const bridge = new FakeBridge();
  const origin = 'https://sigdesktop.example';
  let helper;

  before(async () => {
    await bridge.listen(socketPath);
    helper = await startHelper({
      socketPath,
      port,
      extraArgs: ['--origin', origin],
    });
  });

  after(async () => {
    await helper.stop();
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('logs the proxy name but never the token', () => {
    assert.match(helper.output(), new RegExp(`serving ${origin}/ `));
    assert.ok(!helper.output().includes(helper.token));
  });

  it('accepts requests for the proxy name', async () => {
    const res = await http(port, {
      path: `/${helper.token}/api/state`,
      headers: {
        host: 'sigdesktop.example',
        origin,
        'sec-fetch-site': 'same-origin',
      },
    });
    assert.equal(res.status, 200);
  });

  it('still accepts loopback requests', async () => {
    const res = await http(port, { path: `/${helper.token}/api/state` });
    assert.equal(res.status, 200);
  });

  it('refuses the proxy name over plain http', async () => {
    const res = await http(port, {
      path: `/${helper.token}/api/state`,
      headers: {
        host: 'sigdesktop.example',
        origin: 'http://sigdesktop.example',
      },
    });
    assert.equal(res.status, 403);
  });

  it('refuses other names', async () => {
    const res = await http(port, {
      path: `/${helper.token}/api/state`,
      headers: { host: 'evil.example' },
    });
    assert.equal(res.status, 421);
  });
});
