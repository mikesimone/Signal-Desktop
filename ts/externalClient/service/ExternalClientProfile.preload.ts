// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { Emoji } from '../../axo/emoji.std.ts';
import { createLogger } from '../../logging/log.std.ts';
import { writeProfile } from '../../services/writeProfile.preload.ts';
import * as Errors from '../../types/errors.std.ts';
import { getLocalAvatarUrl } from '../../util/avatarUtils.preload.ts';
import { getConversation } from '../../util/getConversation.preload.ts';
import * as grapheme from '../../util/grapheme.std.ts';
import { imagePathToBytes } from '../../util/imagePathToBytes.dom.ts';
import { normalizeProfileName } from '../../util/normalizeProfileName.std.ts';
import { getAvatarVersion } from '../conversationDto.std.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import type {
  ProfileDTO,
  ProfileGetResultType,
  ProfileSetAvatarParamsType,
  ProfileSetParamsType,
} from '../protocol.std.ts';
import {
  ErrorCode,
  MAX_PROFILE_AVATAR_BYTES,
  PROFILE_ABOUT_MAX_BYTES,
  PROFILE_ABOUT_MAX_GRAPHEMES,
  PROFILE_NAME_MAX_BYTES,
  PROFILE_NAME_MAX_GRAPHEMES,
} from '../protocol.std.ts';

// Fork addition: Signal's profile editor for external clients (decision
// F12). Saves go through writeProfile, as the editor's myProfileChanged.

const log = createLogger('ExternalClientProfile');

// Signal's avatar editor output: a cover-cropped square, at most this size.
const AVATAR_SIDE_PX = 512;

function readProfile(): ProfileDTO {
  const me = getConversation(
    window.ConversationController.getOurConversationOrThrow()
  );
  return {
    conversationId: me.id,
    firstName: me.firstName ?? '',
    familyName: me.familyName ?? '',
    aboutText: me.aboutText ?? '',
    aboutEmoji: me.aboutEmoji ?? '',
    username: me.username ?? null,
    avatarColor: me.color ?? null,
    avatarVersion: getAvatarVersion(me),
  };
}

function profileResult(): ServiceResultType {
  const value: ProfileGetResultType = { profile: readProfile() };
  return { ok: true, value };
}

export function getProfile(): ServiceResultType {
  return profileResult();
}

function fits(text: string, maxGraphemes: number, maxBytes: number): boolean {
  return (
    grapheme.count(text) <= maxGraphemes &&
    new TextEncoder().encode(text).length <= maxBytes
  );
}

export async function setProfile(
  params: ProfileSetParamsType
): Promise<ServiceResultType> {
  const firstName = normalizeProfileName(params.firstName);
  const familyName = normalizeProfileName(params.familyName);
  const aboutText = params.aboutText.trim() || undefined;
  const aboutEmoji = params.aboutEmoji || undefined;
  if (
    firstName == null ||
    !fits(firstName, PROFILE_NAME_MAX_GRAPHEMES, PROFILE_NAME_MAX_BYTES) ||
    !fits(
      familyName ?? '',
      PROFILE_NAME_MAX_GRAPHEMES,
      PROFILE_NAME_MAX_BYTES
    ) ||
    !fits(
      aboutText ?? '',
      PROFILE_ABOUT_MAX_GRAPHEMES,
      PROFILE_ABOUT_MAX_BYTES
    ) ||
    (aboutEmoji != null && !Emoji.isEmoji(aboutEmoji))
  ) {
    return { ok: false, code: ErrorCode.InvalidArgument };
  }
  try {
    const me = getConversation(
      window.ConversationController.getOurConversationOrThrow()
    );
    await writeProfile(
      {
        ...me,
        firstName,
        familyName,
        aboutText,
        // Checked above; Signal's picker hands its editor the same strings.
        aboutEmoji: aboutEmoji as Emoji.Variant | undefined,
      },
      { keepAvatar: true, reupload: false }
    );
  } catch (error) {
    log.warn('setProfile failed', Errors.toLogFormat(error));
    return { ok: false, code: ErrorCode.InternalError };
  }
  log.info('setProfile: saved');
  return profileResult();
}

export async function toAvatarBytes(
  data: string
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_PROFILE_AVATAR_BYTES) {
    return undefined;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
  } catch {
    return undefined;
  }
  try {
    const { width, height } = bitmap;
    if (width < 2 || height < 2) {
      return undefined;
    }
    const side = Math.min(width, height);
    const out = Math.min(side, AVATAR_SIDE_PX);
    const canvas = new OffscreenCanvas(out, out);
    const context = canvas.getContext('2d');
    if (!context) {
      return undefined;
    }
    context.imageSmoothingQuality = 'medium';
    context.drawImage(
      bitmap,
      (width - side) / 2,
      (height - side) / 2,
      side,
      side,
      0,
      0,
      out,
      out
    );
    const blob = await canvas.convertToBlob({ type: 'image/jpeg' });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

export async function setProfileAvatar(
  params: ProfileSetAvatarParamsType
): Promise<ServiceResultType> {
  let newAvatar: Uint8Array<ArrayBuffer> | undefined;
  if (params.data != null) {
    newAvatar = await toAvatarBytes(params.data);
    if (!newAvatar) {
      return { ok: false, code: ErrorCode.InvalidArgument };
    }
  }
  try {
    const model = window.ConversationController.getOurConversationOrThrow();
    // Signal compares against the current photo to decide what changed.
    let oldAvatar: Uint8Array<ArrayBuffer> | undefined;
    const currentUrl = getLocalAvatarUrl(model.attributes);
    if (currentUrl) {
      try {
        oldAvatar = await imagePathToBytes(currentUrl);
      } catch {
        oldAvatar = undefined;
      }
    }
    await writeProfile(getConversation(model), {
      keepAvatar: false,
      avatarUpdate: { oldAvatar, newAvatar, reupload: false },
    });
  } catch (error) {
    log.warn('setProfileAvatar failed', Errors.toLogFormat(error));
    return { ok: false, code: ErrorCode.InternalError };
  }
  log.info(`setProfileAvatar: ${newAvatar ? 'changed' : 'removed'}`);
  return profileResult();
}
