// SPDX-License-Identifier: MPL-2.0
// What every page shares (soundfolk docs/16-sharing.md §5): Radio-Browser, listening in the page,
// Open in Soundfolk, Copy link and Get Soundfolk. Texts from a link or from Radio-Browser are
// only ever set as text, never as HTML.
import { schemeLink } from './link.js';

/** Radio-Browser's mirrors, tried in order. They all serve CORS. */
const MIRRORS = [
  'https://all.api.radio-browser.info',
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://fi1.api.radio-browser.info',
];

/** An element with its text and attributes; children appended as nodes or text. */
export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') node.className = value;
    else node.setAttribute(name, value === true ? '' : value);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

export const $ = (id) => document.getElementById(id);

/** Sets a node's text, showing it only when there is some. */
export function setText(node, text) {
  node.textContent = text ?? '';
  node.hidden = !text;
}

/** Catalog stations by UUID, in the order asked; the ones Radio-Browser no longer has are left
 *  out. Throws when no mirror answers. */
export async function stationsByUuid(uuids) {
  if (uuids.length === 0) return [];
  const query = `/json/stations/byuuid?uuids=${uuids.map(encodeURIComponent).join(',')}`;
  let lastError;
  for (const mirror of MIRRORS) {
    try {
      const response = await fetch(mirror + query, {
        signal: AbortSignal.timeout(8000),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const found = await response.json();
      const byId = new Map(found.map((s) => [String(s.stationuuid).toLowerCase(), s]));
      return uuids.map((id) => byId.get(id.toLowerCase())).filter(Boolean);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** What a station's line says under its name: country, codec and bitrate. */
export function stationMeta(station) {
  const parts = [];
  if (station.country) parts.push(station.country);
  const codec = station.codec && station.codec !== 'UNKNOWN' ? station.codec : '';
  // Some entries give bits per second: no stream has more than a few hundred kbps.
  const bitrate = station.bitrate > 2000 ? Math.round(station.bitrate / 1000) : station.bitrate;
  if (codec && bitrate > 0) parts.push(`${codec} ${bitrate} kbps`);
  else if (codec) parts.push(codec);
  return parts.join(' · ');
}

/** The stream the page may play: a catalog station's own stream over https, never HLS (§5.2).
 *  A stream given as `http` is tried over `https` at the same address, which many servers also
 *  serve (an explicit port is the plain-text one: not tried). The address is still the
 *  catalog's, never one from a link (§6.4). */
export function playableStream(station) {
  const url = String(station.url_resolved || station.url || '');
  if (station.hls === 1 || /\.m3u8(\?|$)/i.test(url)) return null;
  if (url.startsWith('https://')) return url;
  if (/^http:\/\/[^/:]+(\/|$)/.test(url)) return `https://${url.slice('http://'.length)}`;
  return null;
}

// ── Listening in the page ───────────────────────────────────────────────────

const audio = new Audio();
audio.preload = 'none';
/** The button of the station playing, or loading. */
let current = null;

function label(button, playing) {
  button.textContent = playing ? '■ Stop' : '▶ Listen';
  button.setAttribute('aria-pressed', String(playing));
}

/** Stops what plays, if anything. */
export function stop() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (current) label(current, false);
  current = null;
}

audio.addEventListener('error', () => {
  if (!current || !audio.getAttribute('src')) return;
  const button = current;
  stop();
  // Not served over https, or in a format the browser does not play.
  button.replaceWith(appOnly());
});

/** A Listen button for a stream: one station plays at a time, and only after a click. */
export function listenButton(stream, name) {
  const button = el('button', { class: 'button listen', type: 'button' });
  button.title = `Listen to ${name}`;
  label(button, false);
  button.addEventListener('click', () => {
    if (current === button) return stop();
    stop();
    current = button;
    label(button, true);
    audio.src = stream;
    audio.play().catch(() => {
      if (current === button) audio.dispatchEvent(new Event('error'));
    });
  });
  return button;
}

/** What shows in place of Listen for a stream the page cannot play. */
export const appOnly = () => el('span', { class: 'muted' }, 'Plays in the Soundfolk app');

// ── Open in Soundfolk, Copy link ────────────────────────────────────────────

/** Wires the page's Open in Soundfolk and Copy link buttons. */
export function setUpActions() {
  const open = $('open');
  const hint = $('hint');
  open.href = schemeLink(location);
  window.addEventListener('hashchange', () => (open.href = schemeLink(location)));
  // `soundfolk://` not registered: the browser does nothing, and a page cannot tell. If the
  // page still has the focus a moment later, it says what to do (§5.3).
  open.addEventListener('click', () => {
    hint.hidden = true;
    let left = false;
    const away = () => (left = true);
    window.addEventListener('blur', away, { once: true });
    document.addEventListener('visibilitychange', away, { once: true });
    setTimeout(() => {
      window.removeEventListener('blur', away);
      document.removeEventListener('visibilitychange', away);
      if (!left && document.hasFocus()) hint.hidden = false;
    }, 2000);
  });

  const copy = $('copy');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      copy.textContent = '✓ Link copied';
    } catch {
      copy.textContent = 'Copy it from the address bar';
    }
  });
}

// ── Get Soundfolk ───────────────────────────────────────────────────────────

const RELEASES = 'https://github.com/getsoundfolk/soundfolk/releases/latest';

/** Fills the Get Soundfolk section for the visitor's system (§5.3). The latest release is
 *  written by the site's build in /release.json: the page asks nothing of GitHub's API. */
export async function setUpGet() {
  const box = $('get-body');
  const ua = navigator.userAgent;
  const mobile =
    /Android|iPhone|iPad|iPod/i.test(ua) || (navigator.maxTouchPoints > 1 && /Mac/.test(ua));
  const linux = /Linux|X11/.test(ua) && !/Android/i.test(ua);
  if (!linux) {
    box.replaceChildren(
      el(
        'p',
        {},
        mobile
          ? 'Soundfolk runs on Linux computers for now, with apps for phones to come.'
          : 'Soundfolk runs on Linux for now; Windows and macOS are to come.',
      ),
      el(
        'p',
        { class: 'muted' },
        'Listen here in the meantime, or send the link to your Linux computer.',
      ),
      el('p', {}, el('a', { href: RELEASES }, 'All downloads')),
    );
    return;
  }
  let release = null;
  try {
    const response = await fetch('/release.json', { signal: AbortSignal.timeout(5000) });
    if (response.ok) release = await response.json();
  } catch {
    // The link to the releases is enough.
  }
  const deb = release?.deb;
  box.replaceChildren(
    el('p', {}, 'Free software for Linux. For Debian, Ubuntu, Linux Mint and their derivatives:'),
    el(
      'div',
      { class: 'actions' },
      el(
        'a',
        { class: 'button primary', href: deb?.url ?? RELEASES },
        deb ? `Download Soundfolk ${release.version} (.deb)` : 'Download Soundfolk (.deb)',
      ),
    ),
    el(
      'p',
      { class: 'muted small' },
      'Then open the file, or install it from a terminal: ',
      el('code', {}, `sudo apt install ./${deb?.name ?? 'Soundfolk_*_amd64.deb'}`),
    ),
    el(
      'p',
      { class: 'muted small' },
      'Every build is signed by GitHub: ',
      el('code', {}, 'gh attestation verify <file> -R getsoundfolk/soundfolk'),
      '. ',
      el('a', { href: RELEASES }, 'All downloads'),
    ),
  );
}

/** The sender and the track a link carries, as the app shows them. */
export function noteText(link) {
  if (!link) return '';
  if (link.from && link.track) return `${link.from} was listening to ${link.track}`;
  if (link.from) return `Sent by ${link.from}`;
  if (link.track) return `On air when the link was made: ${link.track}`;
  return '';
}
