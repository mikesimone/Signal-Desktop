// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// Voice-note transcripts (decision F60), as Backchannel Android v14. The
// helper sends each voice note to a speech-to-text server you run yourself
// (the kit's optional `transcribe` service, or any server with the OpenAI
// /v1/audio/transcriptions API), so the audio never leaves your machines.
// Off unless BACKCHANNEL_TRANSCRIBE_URL is set. Transcripts are kept in the
// config folder (transcripts.json, mode 0600).

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const MAX_KEPT = 5000;
const CHUNK = 512 * 1024;
// Longer than this and it's not a voice note anyone waits on.
const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 5 * 60 * 1000;

function extensionFor(contentType) {
  const sub = String(contentType ?? '').split('/')[1] ?? 'bin';
  return (
    { mpeg: 'mp3', 'x-m4a': 'm4a', mp4: 'm4a', aac: 'aac' }[sub] ??
    sub.replace(/[^a-z0-9]/g, '')
  );
}

export class Transcriber {
  #file;
  #url;
  #model;
  #bridge;
  #fetch;
  #log;
  #onText;
  #texts = new Map();
  #inFlight = new Map();
  #queue = Promise.resolve();
  #modelReady = false;

  constructor(
    file,
    { url, model, bridge, fetchImpl = globalThis.fetch, log = () => {}, onText }
  ) {
    this.#file = file;
    this.#url = url ? String(url).replace(/\/+$/, '') : null;
    this.#model = model || 'Systran/faster-whisper-small';
    this.#bridge = bridge;
    this.#fetch = fetchImpl;
    this.#log = log;
    this.#onText = onText ?? (() => {});
    if (file && existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        this.#texts = new Map(Object.entries(parsed ?? {}).slice(-MAX_KEPT));
      } catch {
        this.#texts = new Map();
      }
    }
  }

  enabled() {
    return this.#url != null;
  }

  // Every voice note is transcribed as soon as Signal has it.
  handle(m) {
    if (!this.enabled()) {
      return this.#queue;
    }
    (m?.attachments ?? []).forEach((a, index) => {
      if (a.isVoiceMessage && a.state === 'ready') {
        this.request(m.id, index).catch(() => {});
      }
    });
    return this.#queue;
  }

  // The transcript, or null when there is no speech. Rejects when the
  // server can't be reached or the attachment isn't audio.
  request(messageId, index) {
    const key = `${messageId}:${index}`;
    if (this.#texts.has(key)) {
      return Promise.resolve(this.#texts.get(key));
    }
    if (!this.enabled()) {
      return Promise.reject(
        Object.assign(new Error('off'), { code: 'UNAVAILABLE' })
      );
    }
    let work = this.#inFlight.get(key);
    if (!work) {
      // One at a time: the speech server is the slow part.
      work = this.#queue.then(() => this.#transcribe(messageId, index, key));
      this.#queue = work.catch(() => {});
      this.#inFlight.set(key, work);
      work.finally(() => this.#inFlight.delete(key)).catch(() => {});
    }
    return work;
  }

  async #transcribe(messageId, index, key) {
    const { bytes, contentType } = await this.#read(messageId, index);
    let text;
    try {
      text = await this.#post(bytes, contentType);
    } catch (error) {
      this.#log(`transcribe failed: ${error.code ?? error.message}`);
      throw error;
    }
    const clean = String(text ?? '').trim() || null;
    this.#texts.set(key, clean);
    while (this.#texts.size > MAX_KEPT) {
      this.#texts.delete(this.#texts.keys().next().value);
    }
    this.#save();
    this.#onText({ messageId, index, text: clean });
    return clean;
  }

  async #read(messageId, index) {
    const chunks = [];
    let offset = 0;
    let size = Infinity;
    let contentType = '';
    while (offset < size) {
      // oxlint-disable-next-line no-await-in-loop
      const chunk = await this.#bridge.call('attachments.read', {
        messageId,
        index,
        offset,
        length: CHUNK,
      });
      ({ size, contentType } = chunk);
      if (!/^audio\//.test(contentType ?? '') || size > MAX_BYTES) {
        throw Object.assign(new Error('not audio'), {
          code: 'INVALID_ARGUMENT',
        });
      }
      const bytes = Buffer.from(chunk.data, 'base64');
      if (bytes.length === 0) {
        break;
      }
      chunks.push(bytes);
      offset += bytes.length;
    }
    return { bytes: Buffer.concat(chunks), contentType };
  }

  // speaches keeps models on disk and fetches one when asked; the first ask
  // downloads it (201 once it's there), later ones return at once.
  async #ensureModel() {
    if (this.#modelReady) {
      return;
    }
    const res = await this.#fetch(
      `${this.#url}/v1/models/${this.#model.split('/').map(encodeURIComponent).join('/')}`,
      { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS) }
    ).catch(() => null);
    // Other OpenAI-style servers have no such route; carry on regardless.
    this.#modelReady = res != null;
  }

  async #post(bytes, contentType) {
    await this.#ensureModel();
    const form = new FormData();
    form.set('model', this.#model);
    form.set('response_format', 'json');
    form.set(
      'file',
      new Blob([bytes], { type: contentType }),
      `voice.${extensionFor(contentType)}`
    );
    let res;
    try {
      res = await this.#fetch(`${this.#url}/v1/audio/transcriptions`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw Object.assign(new Error('unreachable'), { code: 'UNREACHABLE' });
    }
    if (!res.ok) {
      throw Object.assign(new Error(`HTTP ${res.status}`), {
        code: 'TRANSCRIBE_ERROR',
      });
    }
    const body = await res.json().catch(() => ({}));
    return body.text;
  }

  #save() {
    if (!this.#file) {
      return;
    }
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.#texts)), {
      mode: 0o600,
    });
    renameSync(tmp, this.#file);
  }
}
