// SPDX-License-Identifier: MPL-2.0
// Tests of site/assets/link.js, mirroring the app's (soundfolk src-tauri/src/share.rs). Run with
// `node --test scripts/`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LinkError, clean, readFragment, schemeLink, unpackUuids } from '../site/assets/link.js';

const FIP = '96062a7b-0601-11e8-ae97-52543be04c81';
const OTHER = '78012206-1aa1-11e9-a80b-52543be04c81';

/** UUIDs packed as the app packs them. */
const pack = (ids) =>
  Buffer.from(ids.map((id) => id.replace(/-/g, '')).join(''), 'hex').toString('base64url');

const fails = (kind, hash, pattern) =>
  assert.throws(
    () => readFragment(kind, hash),
    (e) => e instanceof LinkError && pattern.test(e.message),
  );

test('a catalog station, bare or with its sender and track', () => {
  assert.deepEqual(readFragment('s', `#${FIP.toUpperCase()}`), {
    item: { kind: 'station', id: FIP },
    track: null,
    from: null,
  });
  assert.deepEqual(readFragment('s', `#id=${FIP}&t=Nina+Simone+%E2%80%94+Sinnerman&f=Ana`), {
    item: { kind: 'station', id: FIP },
    track: 'Nina Simone — Sinnerman',
    from: 'Ana',
  });
  fails('s', '#not-a-uuid', /station's id/);
});

test('a personal station', () => {
  const link = readFragment(
    's',
    '#n=Radio+du+coin&u=http%3A%2F%2Fstream.example.org%3A8000%2Flive',
  );
  assert.deepEqual(link.item, {
    kind: 'personal_station',
    name: 'Radio du coin',
    url: 'http://stream.example.org:8000/live',
  });
  fails('s', '#n=X&u=ftp%3A%2F%2Fexample.org%2F', /web address/);
  fails('s', '#u=https%3A%2F%2Fexample.org%2F', /no name/);
  fails('s', '#n=X', /no address/);
});

test('texts are cleaned, and too long is refused whole', () => {
  assert.equal(clean('  a‮b​ c\n\td '), 'ab c d');
  assert.equal(clean('é'), 'é');
  const link = readFragment('s', `#id=${FIP}&f=%E2%80%AE+++`);
  assert.equal(link.from, null);
  fails('s', `#id=${FIP}&f=${'x'.repeat(41)}`, /too long/);
});

test('a newer format is said so', () => {
  assert.throws(() => readFragment('s', `#id=${FIP}&v=2`), /newer Soundfolk/);
  assert.equal(readFragment('s', `#id=${FIP}&v=1`).item.id, FIP);
});

test('a published list, by path or fragment', () => {
  assert.deepEqual(readFragment('l', '', 'ambient-focus').item, {
    kind: 'list',
    id: 'ambient-focus',
  });
  assert.deepEqual(readFragment('l', '#f=Ana', 'ambient-focus'), {
    item: { kind: 'list', id: 'ambient-focus' },
    track: null,
    from: 'Ana',
  });
  assert.deepEqual(readFragment('l', '#ambient-focus').item, { kind: 'list', id: 'ambient-focus' });
  assert.deepEqual(readFragment('l', '#id=ambient-focus&f=Ana').from, 'Ana');
  fails('l', '#Ambient_Focus', /list's id/);
});

test('a personal list', () => {
  const hash = `#n=Mes+radios&s=${pack([FIP, OTHER])}&p=Radio+du+coin%0Ahttps%3A%2F%2Fexample.org%2Flive`;
  assert.deepEqual(readFragment('l', hash).item, {
    kind: 'personal_list',
    title: 'Mes radios',
    stations: [FIP, OTHER],
    personal: [{ name: 'Radio du coin', url: 'https://example.org/live' }],
  });
  fails('l', `#n=X&s=${pack([FIP, FIP])}`, /twice/);
  fails('l', '#n=X', /empty/);
  fails('l', `#s=${pack([FIP])}`, /no title/);
  fails('l', '#n=X&s=abc', /cannot be read/);
  fails('l', '#n=X&p=no-address', /no address/);
  const many = Array.from(
    { length: 41 },
    (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
  );
  fails('l', `#n=X&s=${pack(many)}`, /too many/);
});

test('UUIDs unpack as the app packs them', () => {
  assert.deepEqual(unpackUuids(pack([FIP])), [FIP]);
});

test('an empty fragment is no link', () => {
  assert.equal(readFragment('s', ''), null);
  assert.equal(readFragment('l', '#'), null);
});

test("the app's scheme link", () => {
  assert.equal(
    schemeLink({ pathname: '/l/ambient-focus/', hash: '#f=Ana' }),
    'soundfolk://l/ambient-focus/#f=Ana',
  );
  assert.equal(schemeLink({ pathname: '/s/', hash: `#${FIP}` }), `soundfolk://s/#${FIP}`);
});
