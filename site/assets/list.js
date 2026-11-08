// SPDX-License-Identifier: MPL-2.0
// /l/: a list shared from Soundfolk (soundfolk docs/16-sharing.md §5.1, §5.4).
// * A published list's own page, /l/<id>/, is written by the site's build with its stations: this
//   script only adds the Listen buttons and the sender's note.
// * /l/#<id>, where 404.html sends a list published since the last build: read from lists.json.
// * /l/#n=…&s=…&p=…, a listener's own list: catalog stations from Radio-Browser, the ones added by
//   hand with the name the link gives (they play in the app only, §6.4).
import { LinkError, readFragment } from './link.js';
import {
  $,
  appOnly,
  el,
  listenButton,
  noteText,
  playableStream,
  setText,
  setUpActions,
  setUpGet,
  stationMeta,
  stop,
  stationsByUuid,
} from './page.js';

const LISTS = '/soundfolk-stations/v1/lists.json';

function domain(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A station's line: its name, what is known of it, and Listen when the page can play it. */
function row(name, sub, stream) {
  return el(
    'li',
    {},
    el('span', { class: 'name' }, name),
    sub ? el('span', { class: 'sub' }, sub) : null,
    stream ? listenButton(stream, name) : appOnly(),
  );
}

/** "by @a, @b", each login a link to its GitHub profile. */
function showCurators(curators) {
  const meta = $('meta');
  const parts = (curators ?? []).flatMap((c, i) => [
    i ? ', ' : 'by ',
    el('a', { href: `https://github.com/${encodeURIComponent(c)}`, rel: 'noopener' }, `@${c}`),
  ]);
  meta.replaceChildren(...parts);
  meta.hidden = !parts.length;
}

function failed(title, text) {
  $('kicker').textContent = 'Soundfolk link';
  $('title').textContent = title;
  setText($('meta'), text);
  $('stations').replaceChildren();
}

async function catalogRows(uuids) {
  const found = await stationsByUuid(uuids);
  const rows = found.map((s) => row(s.name, stationMeta(s), playableStream(s)));
  return { rows, missing: uuids.length - found.length };
}

function missingText(missing) {
  if (missing <= 0) return '';
  return missing === 1
    ? 'One of its stations is no longer in the catalog.'
    : `${missing} of its stations are no longer in the catalog.`;
}

async function showPersonal(item) {
  $('kicker').textContent = 'A listener’s list';
  $('title').textContent = item.title;
  document.title = `${item.title} · Soundfolk`;
  const count = item.stations.length + item.personal.length;
  setText($('meta'), `${count} ${count === 1 ? 'station' : 'stations'}`);
  const personal = item.personal.map((p) => row(p.name, `${domain(p.url)} · added by hand`, null));
  try {
    const { rows, missing } = await catalogRows(item.stations);
    $('stations').replaceChildren(...rows, ...personal);
    setText($('missing'), missingText(missing));
  } catch {
    $('stations').replaceChildren(...personal);
    setText($('missing'), 'Radio-Browser, the catalog of stations, does not answer right now.');
  }
}

async function showPublished(id) {
  $('kicker').textContent = 'List';
  $('title').textContent = 'Loading…';
  let list;
  try {
    const response = await fetch(LISTS, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    list = (await response.json()).lists.find((l) => l.id === id);
  } catch {
    return failed('A Soundfolk list', 'The lists cannot be read right now.');
  }
  if (!list) {
    $('open').hidden = true;
    return failed(
      'List not found',
      'This list is not published: it was removed, or it is not merged yet.',
    );
  }
  $('title').textContent = list.title;
  document.title = `${list.title} · Soundfolk`;
  setText($('description'), list.description);
  showCurators(list.curators);
  try {
    const { rows, missing } = await catalogRows(list.items.map((i) => i.uuid));
    $('stations').replaceChildren(...rows);
    setText($('missing'), missingText(missing));
  } catch {
    setText($('missing'), 'Radio-Browser, the catalog of stations, does not answer right now.');
  }
}

async function show() {
  // A page written by the build: its stations are there, they only need their buttons.
  const built = document.body.dataset.list;
  // A new link in the same page (hashchange): nothing of the last one stays.
  $('open').hidden = false;
  $('hint').hidden = true;
  if (!built) {
    document.title = 'A list on Soundfolk';
    setText($('description'), '');
    setText($('meta'), '');
    setText($('missing'), '');
    stop();
    $('stations').replaceChildren();
  }
  let link;
  try {
    link = readFragment('l', location.hash, built ?? null);
  } catch (error) {
    if (built) link = null;
    else {
      $('open').hidden = true;
      return failed(error instanceof LinkError ? error.message : 'This link cannot be read.', '');
    }
  }
  setText($('note'), noteText(link));
  if (built) return;
  if (!link) {
    $('open').hidden = true;
    return failed('This link is incomplete.', '');
  }
  if (link.item.kind === 'personal_list') return showPersonal(link.item);
  return showPublished(link.item.id);
}

/** Listen buttons on a built page's rows (`data-stream`, written by the build). */
function wireBuiltRows() {
  for (const li of document.querySelectorAll('#stations li[data-stream]')) {
    if (!li.dataset.stream.startsWith('https://')) continue;
    const name = li.querySelector('.name')?.textContent ?? '';
    li.querySelector('.muted')?.remove();
    li.append(listenButton(li.dataset.stream, name));
  }
}

setUpActions();
setUpGet();
wireBuiltRows();
show();
window.addEventListener('hashchange', show);
