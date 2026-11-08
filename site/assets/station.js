// SPDX-License-Identifier: MPL-2.0
// /s/: a station shared from Soundfolk (soundfolk docs/16-sharing.md §5.1). A catalog station's
// name comes from Radio-Browser and it can be played here; a station added by hand shows the name
// the link gives and plays in the app only (§6.4).
import { LinkError, readFragment } from './link.js';
import {
  $,
  appOnly,
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

function domain(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function show() {
  // A new link in the same page (hashchange): nothing of the last one stays.
  $('open').hidden = false;
  $('hint').hidden = true;
  document.title = 'A station on Soundfolk';
  setText($('meta'), '');
  stop();
  $('listen').replaceChildren();
  let link;
  try {
    link = readFragment('s', location.hash);
  } catch (error) {
    $('kicker').textContent = 'Soundfolk link';
    $('title').textContent =
      error instanceof LinkError ? error.message : 'This link cannot be read.';
    $('open').hidden = true;
    return;
  }
  if (!link) {
    $('kicker').textContent = 'Soundfolk link';
    $('title').textContent = 'This link is incomplete.';
    $('open').hidden = true;
    return;
  }
  setText($('note'), noteText(link));
  const item = link.item;

  if (item.kind === 'personal_station') {
    $('kicker').textContent = 'Station';
    $('title').textContent = item.name;
    document.title = `${item.name} · Soundfolk`;
    setText($('meta'), `Stream from ${domain(item.url)} · added by hand, not in the catalog`);
    $('listen').replaceChildren(appOnly());
    return;
  }

  $('kicker').textContent = 'Station';
  $('title').textContent = 'Loading…';
  let station;
  try {
    [station] = await stationsByUuid([item.id]);
  } catch {
    $('title').textContent = 'A Soundfolk station';
    setText($('meta'), 'Radio-Browser, the catalog of stations, does not answer right now.');
    return;
  }
  if (!station) {
    $('title').textContent = 'Station not found';
    setText($('meta'), 'This station is no longer in the catalog.');
    $('open').hidden = true;
    return;
  }
  $('title').textContent = station.name;
  document.title = `${station.name} · Soundfolk`;
  setText($('meta'), stationMeta(station));
  const stream = playableStream(station);
  $('listen').replaceChildren(stream ? listenButton(stream, station.name) : appOnly());
}

setUpActions();
setUpGet();
show();
window.addEventListener('hashchange', show);
