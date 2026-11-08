// SPDX-License-Identifier: MPL-2.0
// Reads a share link's fragment as the app does (soundfolk docs/16-sharing.md §2.2, §6.1;
// src-tauri/src/share.rs). A link is data from a stranger: every text is cleaned, and a link
// breaking a limit is refused whole. Keep this file and share.rs in step.

/** Limits of §2.2, in characters of the cleaned text. */
const MAX_LIST_TITLE = 40;
const MAX_STATION_NAME = 80;
const MAX_STREAM_URL = 2000;
const MAX_TRACK = 200;
const MAX_FROM = 40;
const MAX_LIST_STATIONS = 40;
const MAX_LIST_ID = 64;

/** A link that cannot be read, with the reason in words for the visitor. */
export class LinkError extends Error {}

const invalid = (reason) => new LinkError(`This link is incomplete: ${reason}.`);
const NEWER = 'This link was made by a newer Soundfolk.';

/** Formatting characters that change how text shows without showing themselves. */
const INVISIBLE = /[­؜ᅟᅠㅤﾠ᠎​-‏‪-‮⁠-⁤⁦-⁩⁪-⁯﻿￹-￻\u{E0000}-\u{E007F}]/gu;

/** NFC, without control and invisible characters, white space collapsed. */
export function clean(text) {
  return text
    .normalize('NFC')
    .replace(/\s/gu, ' ')
    .replace(/\p{Cc}/gu, '')
    .replace(INVISIBLE, '')
    .split(' ')
    .filter(Boolean)
    .join(' ');
}

const length = (text) => [...text].length;

export const isUuid = (text) =>
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(text);

export const isListId = (id) =>
  id.length > 0 && id.length <= MAX_LIST_ID && /^[a-z0-9-]+$/.test(id);

/** `application/x-www-form-urlencoded` decoding, as the app reads fragments. */
function decode(text) {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    throw invalid('it cannot be read');
  }
}

function pairs(fragment) {
  return fragment
    .split('&')
    .filter(Boolean)
    .map((part) => {
      const at = part.indexOf('=');
      return at < 0 ? [decode(part), ''] : [decode(part.slice(0, at)), decode(part.slice(at + 1))];
    });
}

/** 16-byte UUIDs packed in base64url without padding (§2.2). */
export function unpackUuids(packed) {
  packed = packed.trim();
  if (!/^[A-Za-z0-9_-]*$/.test(packed) || packed.length % 4 === 1) {
    throw invalid("the list's stations cannot be read");
  }
  const binary = atob(packed.replace(/-/g, '+').replace(/_/g, '/'));
  if (binary.length % 16 !== 0) throw invalid("the list's stations cannot be read");
  const ids = [];
  for (let at = 0; at < binary.length; at += 16) {
    const hex = [...binary.slice(at, at + 16)]
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('');
    ids.push(
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    );
  }
  return ids;
}

function optional(fields, key, max) {
  const value = fields.get(key);
  if (value === undefined) return null;
  const text = clean(value);
  if (!text) return null;
  if (length(text) > max) throw invalid('a text is too long');
  return text;
}

function personalEntry(name, url) {
  name = clean(name ?? '');
  if (!name) throw invalid('the station has no name');
  if (length(name) > MAX_STATION_NAME) throw invalid("the station's name is too long");
  url = (url ?? '').trim();
  if (!url) throw invalid('the station has no address');
  if (url.length > MAX_STREAM_URL) throw invalid("the station's address is too long");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw invalid("the station's address is not valid");
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw invalid("the station's address is not a web address");
  }
  return { name, url: parsed.href };
}

/**
 * Reads what a page's fragment carries. `kind` is the page: "s" (station) or "l" (list), and
 * `pathId` a published list's id from the path (`/l/<id>/`).
 * Returns `{ item, track, from }`, `item` being one of
 * `{ kind: 'station', id }`, `{ kind: 'personal_station', name, url }`, `{ kind: 'list', id }`,
 * `{ kind: 'personal_list', title, stations, personal }`; or `null` for an empty fragment.
 * Throws a `LinkError` for a link that cannot be read.
 */
export function readFragment(kind, hash, pathId = null) {
  const fragment = hash.replace(/^#/, '');
  if (!fragment && !pathId) return null;
  let id = null;
  let fields = new Map();
  let all = [];
  if (fragment && !fragment.includes('=')) {
    id = decode(fragment);
  } else if (fragment) {
    all = pairs(fragment);
    for (const [key, value] of all) if (!fields.has(key)) fields.set(key, value);
    if (fields.has('v') && fields.get('v') !== '1') throw new LinkError(NEWER);
  }
  id ??= fields.get('id') ?? null;

  let item;
  if (kind === 's') {
    if (id !== null) {
      if (!isUuid(id)) throw invalid("the station's id is not valid");
      item = { kind: 'station', id: id.toLowerCase() };
    } else {
      const entry = personalEntry(fields.get('n'), fields.get('u'));
      item = { kind: 'personal_station', ...entry };
    }
  } else {
    const listId = pathId ?? id;
    if (listId !== null) {
      if (!isListId(listId)) throw invalid("the list's id is not valid");
      item = { kind: 'list', id: listId };
    } else {
      const title = clean(fields.get('n') ?? '');
      if (!title) throw invalid('the list has no title');
      if (length(title) > MAX_LIST_TITLE) throw invalid("the list's title is too long");
      const packed = fields.get('s');
      const stations = packed ? unpackUuids(packed) : [];
      if (new Set(stations).size !== stations.length)
        throw invalid('a station is in the list twice');
      const personal = all
        .filter(([key]) => key === 'p')
        .map(([, entry]) => {
          const at = entry.indexOf('\n');
          if (at < 0) throw invalid('a station has no address');
          return personalEntry(entry.slice(0, at), entry.slice(at + 1));
        });
      const count = stations.length + personal.length;
      if (count === 0) throw invalid('the list is empty');
      if (count > MAX_LIST_STATIONS) throw invalid('the list has too many stations');
      item = { kind: 'personal_list', title, stations, personal };
    }
  }
  return { item, track: optional(fields, 't', MAX_TRACK), from: optional(fields, 'f', MAX_FROM) };
}

/** The same link with the app's scheme: `https://host/s/#…` becomes `soundfolk://s/#…`. */
export const schemeLink = (location) =>
  `soundfolk://${location.pathname.replace(/^\//, '')}${location.hash}`;
