// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// Signal's large emoji font. Signal Desktop ships a small emoji font and
// downloads this one (about 9 MB) on first use; it covers every emoji at
// every size. The helper uses Signal's downloaded copy when it can read it,
// else downloads the same file once, checks its digest, and keeps it.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

// From Signal Desktop's build/optional-resources.json ("emoji-font.woff2").
export const LARGE_EMOJI_FONT = {
  url: 'https://updates2.signal.org/static/android/emoji/font/desktop-32-64-v2.0.4.woff2',
  digest:
    'DTFJd7ArQkm7EQfOA7yHq7J89Ehf03g3jzCi7WLCUtYfJANE0nc/CL4NqJsCNrImIJnUGMbLliXBQgmSQupXLg==',
};

function matches(bytes) {
  return (
    createHash('sha512').update(bytes).digest('base64') ===
    LARGE_EMOJI_FONT.digest
  );
}

// Resolves to the font's bytes, or null if it cannot be had.
export function largeEmojiFontLoader({ userData, cacheFile, log }) {
  let pending;
  return () => {
    pending ??= (async () => {
      const candidates = [
        userData && join(userData, 'optionalResources', 'emoji-font.woff2'),
        cacheFile,
      ].filter(Boolean);
      for (const file of candidates) {
        try {
          if (existsSync(file)) {
            const bytes = readFileSync(file);
            if (matches(bytes)) {
              return bytes;
            }
          }
        } catch {
          // Unreadable; try the next one.
        }
      }
      try {
        const res = await fetch(LARGE_EMOJI_FONT.url);
        const bytes = Buffer.from(await res.arrayBuffer());
        if (!res.ok || !matches(bytes)) {
          throw new Error(`HTTP ${res.status}, or wrong digest`);
        }
        mkdirSync(dirname(cacheFile), { recursive: true, mode: 0o700 });
        writeFileSync(`${cacheFile}.tmp`, bytes, { mode: 0o600 });
        renameSync(`${cacheFile}.tmp`, cacheFile);
        log("downloaded Signal's large emoji font");
        return bytes;
      } catch (error) {
        log(`large emoji font unavailable: ${error.message}`);
        pending = undefined;
        return null;
      }
    })();
    return pending;
  };
}
