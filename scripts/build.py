#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Builds the site into a folder (soundfolk docs/16-sharing.md §5).

* The pages: home, /download/, /privacy/, /contribute/, /s/ (a station), /l/ (a list read from
  the link), 404. The presentation pages are written from templates/pages/.
* A page per list published in soundfolk-stations, /l/<id>/, with its stations' names and streams
  from Radio-Browser written in, so that it shows without a request and previews well in chat
  apps (§5.4). A list removed since keeps a page saying so: the ids ever built are kept in
  lists-seen.txt, which this script updates.
* The preview images, drawn like the app's default art (Waves.svelte).
* release.json: the latest app release, for the pages' Get Soundfolk.

Needs Python 3.10+ and Pillow. `--offline` builds without the network (no lists, no release).
"""

from __future__ import annotations

import argparse
import html
import json
import math
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from string import Template

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://getsoundfolk.github.io"
LISTS_URL = f"{SITE}/soundfolk-stations/v1/lists.json"
APP_REPO = "getsoundfolk/soundfolk"
RELEASES = f"https://github.com/{APP_REPO}/releases/latest"
# These names all lead to one server today: a mirror is no fallback when that server stalls, so
# the rounds below wait and ask again (RETRY_WAITS, in seconds, before the 2nd and 3rd rounds).
MIRRORS = [
    "https://all.api.radio-browser.info",
    "https://de1.api.radio-browser.info",
    "https://de2.api.radio-browser.info",
]
RETRY_WAITS = [15, 45]
USER_AGENT = "SoundfolkSite/1 (+https://github.com/getsoundfolk/getsoundfolk.github.io)"
LIST_ID = re.compile(r"^[a-z0-9-]{1,64}$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
TAGLINE = "Web radios from around the world, in a free app for Linux, Windows and macOS."
# The packages of a release, by the end of their file name.
PACKAGES = {
    "deb": "_amd64.deb",
    "appimage": "_amd64.AppImage",
    "exe": "_x64-setup.exe",
    "dmg": "_universal.dmg",
}

e = html.escape


# ── Network ──────────────────────────────────────────────────────────────────


def get_json(url: str, headers: dict[str, str] | None = None, timeout: float = 20):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def stations_by_uuid(uuids: list[str]) -> dict[str, dict]:
    """Radio-Browser's stations for these UUIDs, by UUID; raises when no mirror answers in any
    round."""
    if not uuids:
        return {}
    query = "/json/stations/byuuid?" + urllib.parse.urlencode({"uuids": ",".join(uuids)})
    errors: list[str] = []
    for wait in [0, *RETRY_WAITS]:
        if wait:
            print(f"Radio-Browser does not answer, asking again in {wait} s", file=sys.stderr)
            time.sleep(wait)
        for mirror in MIRRORS:
            try:
                found = get_json(mirror + query)
                return {str(s.get("stationuuid", "")).lower(): s for s in found}
            except Exception as exc:  # noqa: BLE001 - the next mirror is tried
                errors.append(f"{mirror}: {exc}")
    raise RuntimeError("Radio-Browser does not answer:\n  " + "\n  ".join(errors))


def published_page(path: str) -> str:
    """The page the site publishes now at this path, to keep it when it cannot be rebuilt."""
    request = urllib.request.Request(f"{SITE}/{path}", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=20) as response:
        return response.read().decode("utf-8")


def latest_release() -> dict | None:
    headers = {"Accept": "application/vnd.github+json"}
    if token := os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {token}"
    release = get_json(f"https://api.github.com/repos/{APP_REPO}/releases/latest", headers)
    found: dict = {
        "version": release["tag_name"].removeprefix("v"),
        "url": release["html_url"],
    }
    for kind, ending in PACKAGES.items():
        asset = next((a for a in release.get("assets", []) if a["name"].endswith(ending)), None)
        found[kind] = (
            {"name": asset["name"], "url": asset["browser_download_url"]} if asset else None
        )
    return found


# ── Stations ─────────────────────────────────────────────────────────────────


def station_meta(station: dict) -> str:
    parts = []
    if station.get("country"):
        parts.append(station["country"])
    codec = station.get("codec") or ""
    codec = "" if codec == "UNKNOWN" else codec
    bitrate = station.get("bitrate") or 0
    # Some entries give bits per second: no stream has more than a few hundred kbps.
    bitrate = round(bitrate / 1000) if bitrate > 2000 else bitrate
    if codec:
        parts.append(f"{codec} {bitrate} kbps" if bitrate > 0 else codec)
    return " · ".join(parts)


def serves_audio(url: str) -> bool:
    """Whether `url` answers with audio: the first bytes of the stream, then the connection
    closed."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Icy-MetaData": "0"})
    try:
        with urllib.request.urlopen(request, timeout=6) as response:
            kind = response.headers.get("Content-Type", "").split(";")[0].strip().lower()
            response.read(1024)
            return response.status == 200 and (
                kind.startswith("audio/") or kind in ("application/ogg", "video/mp2t")
            )
    except Exception:  # noqa: BLE001 - any failure: not served
        return False


def playable_stream(station: dict, probe: bool = True) -> str | None:
    """The stream a page may play: the station's own stream over https, never HLS (§5.2). A
    stream given as `http` is tried over `https` on the same address: many servers have both, and
    the address is still the catalog's, never one from a link (§6.4)."""
    url = str(station.get("url_resolved") or station.get("url") or "")
    if station.get("hls") == 1 or re.search(r"\.m3u8(\?|$)", url, re.IGNORECASE):
        return None
    if any(c in url for c in "\"'<> \n"):
        return None
    if url.startswith("https://"):
        return url
    if probe and url.startswith("http://"):
        secure = "https://" + url.removeprefix("http://")
        # An explicit port is the plain-text one: https on it would not answer.
        if not re.match(r"^https://[^/]+:\d+", secure) and serves_audio(secure):
            return secure
    return None


# ── Pages ────────────────────────────────────────────────────────────────────

BASE = Template((ROOT / "templates" / "base.html").read_text(encoding="utf-8"))

ACTIONS = """\
        <div class="actions">
          {listen}<a class="button primary" id="open" href="/">Open in Soundfolk</a>
          <button class="button copy" id="copy" type="button">Copy link</button>
        </div>
        <p class="hint" id="hint" hidden>
          Nothing happened? Get Soundfolk below, or paste the link in its search.
        </p>"""

GET = f"""\
      <section class="card get" aria-labelledby="get-title">
        <h2 id="get-title">Get Soundfolk</h2>
        <div id="get-body">
          <p>{e(TAGLINE)}</p>
          <p><a href="{RELEASES}">Download Soundfolk</a></p>
        </div>
      </section>"""


def page(
    *,
    title: str,
    main: str,
    script: str | None,
    og_title: str | None = None,
    description: str = TAGLINE,
    og_image: str = f"{SITE}/assets/preview.png",
    canonical: str | None = None,
    body_attrs: str = "",
    wide: bool = False,
) -> str:
    if wide:
        body_attrs += ' class="wide"'
    return BASE.substitute(
        title=e(title),
        og_title=e(og_title or title),
        description=e(description),
        og_image=e(og_image),
        canonical=f'<link rel="canonical" href="{e(canonical)}" />' if canonical else "",
        script=f'<script type="module" src="/assets/{script}"></script>' if script else "",
        body_attrs=body_attrs,
        main=main,
    )


PAGES = ROOT / "templates" / "pages"
SHOTS = ROOT / "site" / "assets" / "shots"


def from_template(name: str, **values: str) -> str:
    return Template((PAGES / f"{name}.html").read_text(encoding="utf-8")).substitute(values)


def shot(name: str, alt: str, kind: str = "shot") -> str:
    """A screenshot of the app, dark or light like the visitor's system: shots/<name>-dark.webp
    and shots/<name>-light.webp, of the same size."""
    from PIL import Image

    with Image.open(SHOTS / f"{name}-dark.webp") as image:
        width, height = image.size
    return f"""<picture class="{kind}">
          <source srcset="/assets/shots/{name}-light.webp" media="(prefers-color-scheme: light)" />
          <img src="/assets/shots/{name}-dark.webp" alt="{e(alt)}" width="{width}" height="{height}" loading="lazy" decoding="async" />
        </picture>"""


def home(lists: list[dict]) -> str:
    items = "\n".join(
        f'          <li><span class="name"><a href="/l/{e(l["id"])}/">{e(l["title"])}</a></span>'
        f'<span class="sub">{e(l.get("description", ""))}</span></li>'
        for l in lists
    )
    lists_section = (
        f"""
      <section class="card" id="lists" aria-labelledby="lists-title">
        <h2 id="lists-title">Lists by listeners</h2>
        <p class="muted">Stations chosen by listeners, for a mood or a moment.</p>
        <ul class="stations">
{items}
        </ul>
        <p class="note"><a href="/contribute/#lists">Make your own list</a></p>
      </section>
"""
        if lists
        else ""
    )
    main = from_template(
        "home",
        shot_player=shot(
            "player",
            "Soundfolk playing a station, with the title on air and a list of favorite stations",
            "shot hero-shot",
        ),
        shot_discover=shot("discover", "Searching the catalog for stations"),
        shot_sheet=shot("sheet", "A station's details: where its title comes from, its stream"),
        shot_history=shot("history", "The listening history, by day, with liked tracks"),
        lists=lists_section,
    ).replace(' loading="lazy"', "", 1)  # the first screenshot is above the fold
    return page(
        title="Soundfolk · Find and play any web radio",
        main=main,
        script="home.js",
        og_title="Soundfolk",
        description="Find and play any web radio. Know what’s playing, keep track of what you "
        "heard. Free, for Linux, Windows and macOS.",
        canonical=f"{SITE}/",
        wide=True,
    )


def download_page(release: dict | None) -> str:
    release = release or {}
    values = {"release_url": release.get("url", RELEASES)}
    for kind, ending in PACKAGES.items():
        asset = release.get(kind) or {"name": f"Soundfolk_*{ending}", "url": RELEASES}
        values[f"{kind}_url"] = e(asset["url"])
        values[f"{kind}_name"] = e(asset["name"])
    version = release.get("version")
    values["version_line"] = f"Version {e(version)}." if version else ""
    return page(
        title="Download · Soundfolk",
        main=from_template("download", **values),
        script=None,
        description="Soundfolk for Debian, Ubuntu and other Linux distributions, Windows and macOS.",
        canonical=f"{SITE}/download/",
        wide=True,
    )


def privacy_page() -> str:
    return page(
        title="Privacy · Soundfolk",
        main=from_template("privacy"),
        script=None,
        description="Everything Soundfolk sends, to whom, and how to turn it off.",
        canonical=f"{SITE}/privacy/",
        wide=True,
    )


def contribute_page() -> str:
    return page(
        title="Contribute · Soundfolk",
        main=from_template("contribute"),
        script=None,
        description="Give titles to a station, add donation links, put together a list, or code.",
        canonical=f"{SITE}/contribute/",
        wide=True,
    )


def station_page() -> str:
    main = f"""\
      <section class="card" aria-labelledby="title">
        <p class="kicker" id="kicker">Station</p>
        <h1 id="title">Loading…</h1>
        <p class="meta" id="meta" hidden></p>
        <p class="note" id="note" hidden></p>
{ACTIONS.format(listen='<span id="listen"></span>')}
      </section>
{GET}"""
    return page(
        title="A station on Soundfolk",
        main=main,
        script="station.js",
        description="Web radios from around the world. Listen right away, or open it in Soundfolk.",
    )


def list_main(
    *, kicker: str, title: str, description: str, meta_html: str, rows: str, missing: str
) -> str:
    def shown(text: str) -> str:
        return "" if text else " hidden"

    return f"""\
      <section class="card" aria-labelledby="title">
        <p class="kicker" id="kicker">{e(kicker)}</p>
        <h1 id="title">{e(title)}</h1>
        <p class="description" id="description"{shown(description)}>{e(description)}</p>
        <p class="meta" id="meta"{shown(meta_html)}>{meta_html}</p>
        <p class="note" id="note" hidden></p>
{ACTIONS.format(listen="")}
        <ol class="stations" id="stations">
{rows}
        </ol>
        <p class="meta small" id="missing"{shown(missing)}>{e(missing)}</p>
      </section>
{GET}"""


def list_link_page() -> str:
    main = list_main(
        kicker="List", title="Loading…", description="", meta_html="", rows="", missing=""
    )
    return page(
        title="A list on Soundfolk",
        main=main,
        script="list.js",
        description="Web radios from around the world. Listen right away, or open it in Soundfolk.",
    )


def curators_text(curators: list[str]) -> str:
    return "by " + ", ".join(f"@{c}" for c in curators) if curators else ""


def curators_html(curators: list[str]) -> str:
    """"by @a, @b", each login a link to its GitHub profile."""
    links = (
        f'<a href="https://github.com/{e(urllib.parse.quote(c))}" rel="noopener">@{e(c)}</a>'
        for c in curators
    )
    return "by " + ", ".join(links) if curators else ""


def published_list_page(lst: dict, stations: dict[str, dict]) -> str:
    found = [stations.get(item["uuid"].lower()) for item in lst["items"]]
    missing = found.count(None)
    found = [s for s in found if s]
    # Streams tried over https at once: a slow server should not hold the others.
    with ThreadPoolExecutor(max_workers=8) as pool:
        streams = list(pool.map(playable_stream, found))
    rows = []
    for station, stream in zip(found, streams):
        name = str(station.get("name") or "").strip() or "Unnamed station"
        sub = station_meta(station)
        attrs = f' data-stream="{e(stream)}"' if stream else ""
        tail = "" if stream else '<span class="muted">Plays in the Soundfolk app</span>'
        sub_html = f'<span class="sub">{e(sub)}</span>' if sub else ""
        rows.append(
            f'          <li{attrs}><span class="name">{e(name)}</span>{sub_html}{tail}</li>'
        )
    missing_text = (
        ""
        if missing == 0
        else "One of its stations is no longer in the catalog."
        if missing == 1
        else f"{missing} of its stations are no longer in the catalog."
    )
    by = curators_text(lst.get("curators", []))
    description = " ".join(x for x in [lst.get("description", ""), by] if x)
    main = list_main(
        kicker="List",
        title=lst["title"],
        description=lst.get("description", ""),
        meta_html=curators_html(lst.get("curators", [])),
        rows="\n".join(rows),
        missing=missing_text,
    )
    return page(
        title=f"{lst['title']} · Soundfolk",
        og_title=lst["title"],
        description=description or TAGLINE,
        main=main,
        script="list.js",
        og_image=f"{SITE}/l/{lst['id']}/preview.png",
        canonical=f"{SITE}/l/{lst['id']}/",
        body_attrs=f' data-list="{e(lst["id"])}"',
    )


def removed_list_page(list_id: str) -> str:
    main = f"""\
      <section class="card" aria-labelledby="title">
        <p class="kicker">List</p>
        <h1 id="title">This list is no longer published</h1>
        <p class="meta">It was removed from Soundfolk’s lists. <a href="/#lists">See the published lists</a>.</p>
      </section>
{GET}"""
    return page(
        title="List no longer published · Soundfolk",
        main=main,
        script="home.js",
        canonical=f"{SITE}/l/{list_id}/",
    )


def not_found_page() -> str:
    main = f"""\
      <section class="card" aria-labelledby="title">
        <h1 id="title">Page not found</h1>
        <p class="meta">This address is not on the site. <a href="/">Soundfolk’s home</a>.</p>
      </section>
{GET}"""
    return page(title="Page not found · Soundfolk", main=main, script="notfound.js")


# ── Images ───────────────────────────────────────────────────────────────────

WIDTH, HEIGHT = 1200, 630
INK = (61, 61, 64)
ORANGE = (234, 88, 12)
LINE = (255, 255, 255, 158)
FONT_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
]


def font(size: int):
    from PIL import ImageFont

    for path in FONT_PATHS:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def waves(scale: int = 2):
    """The app's default art (Waves.svelte) on a 1200×630 canvas, drawn at `scale` and reduced."""
    from PIL import Image, ImageDraw

    w, h = WIDTH * scale, HEIGHT * scale
    image = Image.new("RGB", (w, h), INK)
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    # Waves.svelte draws in a 1500 square, sliced to the tile: here its middle band.
    size, center, amplitude, wavelength, trough, step, slope = 1500, 747, 277, 1160, 500, 52, 0.39
    k = w / size
    top = (size - h / k) / 2

    def path(shift: int) -> list[tuple[float, float]]:
        dx = shift * step
        dy = dx * slope
        points = []
        for x in range(-100, size + 101, 10):
            y = center + dy + amplitude * math.cos(2 * math.pi * (x - dx - trough) / wavelength)
            points.append((x * k, (y - top) * k))
        return points

    for shift in [*range(-8, 0), *range(1, 13)]:
        draw.line(path(shift), fill=LINE, width=max(1, scale))
    draw.line(path(0), fill=ORANGE, width=4 * scale)
    image.paste(overlay, (0, 0), overlay)
    return image.resize((WIDTH, HEIGHT), Image.LANCZOS)


def wrap(draw, text: str, typeface, width: int, lines: int) -> list[str]:
    words, out, line = text.split(), [], ""
    for word in words:
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=typeface) <= width:
            line = trial
            continue
        if line:
            out.append(line)
        line = word
        if len(out) == lines:
            break
    if line and len(out) < lines:
        out.append(line)
    if len(out) == lines and " ".join(out) != " ".join(words):
        while out[-1] and draw.textlength(out[-1] + "…", font=typeface) > width:
            out[-1] = out[-1][:-1]
        out[-1] = out[-1].rstrip() + "…"
    return out


def preview(path: Path, title: str, subtitle: str, kicker: str = "Soundfolk") -> None:
    from PIL import Image, ImageDraw

    image = waves()
    draw = ImageDraw.Draw(image)
    titles = wrap(draw, title, font(58), 1000, 2)
    subtitles = wrap(draw, subtitle, font(30), 1000, 1) if subtitle else []
    # The text's height decides the panel's: kicker, title lines, subtitle, and the margins.
    height = 36 + 64 + 70 * len(titles) + (46 if subtitles else 0) + 40
    top = HEIGHT - 60 - height
    # A dark panel under the text, so that it reads over the lines.
    shade = Image.new("RGBA", image.size, (0, 0, 0, 0))
    ImageDraw.Draw(shade).rounded_rectangle(
        (60, top, 1140, HEIGHT - 60), radius=28, fill=(18, 18, 19, 225)
    )
    image.paste(shade, (0, 0), shade)
    draw = ImageDraw.Draw(image)
    y = top + 36
    draw.ellipse((100, y, 136, y + 36), fill=(240, 160, 40))
    draw.text((152, y + 18), kicker, font=font(30), fill=(237, 237, 237), anchor="lm")
    y += 64
    for line in titles:
        draw.text((100, y), line, font=font(58), fill=(255, 255, 255))
        y += 70
    for line in subtitles:
        draw.text((100, y + 6), line, font=font(30), fill=(194, 194, 198))
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, optimize=True)


# ── Build ────────────────────────────────────────────────────────────────────


def write(out: Path, relative: str, text: str) -> None:
    path = out / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def read_lists(source: str) -> list[dict]:
    data = (
        get_json(source) if source.startswith("https://") else json.loads(Path(source).read_text())
    )
    if data.get("version") != 1:
        raise SystemExit(f"lists.json: unknown version {data.get('version')}")
    lists = []
    for lst in data["lists"]:
        if not LIST_ID.match(str(lst.get("id", ""))):
            print(f"skipping a list with an invalid id: {lst.get('id')!r}", file=sys.stderr)
            continue
        lst["items"] = [
            i for i in lst.get("items", []) if UUID.match(str(i.get("uuid", "")).lower())
        ]
        lists.append(lst)
    return lists


def read_seen(source: str) -> set[str]:
    """The ids of the lists built so far. The site's file missing (the first build) is an empty
    set; the site not answering stops the build, which would otherwise drop the pages of removed
    lists."""
    if source.startswith("https://"):
        request = urllib.request.Request(source, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                text = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                raise
            text = ""
    else:
        path = Path(source)
        text = path.read_text(encoding="utf-8") if path.exists() else ""
    return {i for i in text.split() if LIST_ID.match(i)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("-o", "--out", default="_site", help="folder to build into (emptied)")
    parser.add_argument("--lists", default=LISTS_URL, help="lists.json: an https address or a file")
    parser.add_argument(
        "--seen",
        default=f"{SITE}/lists-seen.txt",
        help="ids of the lists ever built: the published site's file, or a local one",
    )
    parser.add_argument("--offline", action="store_true", help="no network: no lists, no release")
    args = parser.parse_args()

    out = Path(args.out)
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(ROOT / "site", out)

    lists: list[dict] = []
    release = None
    if not args.offline:
        lists = read_lists(args.lists)
        try:
            release = latest_release()
        except Exception as exc:  # noqa: BLE001 - the pages link to the releases instead
            print(f"no release information: {exc}", file=sys.stderr)
            release = None
        if release:
            write(out, "release.json", json.dumps(release, indent=1) + "\n")

    write(out, "index.html", home(lists))
    write(out, "download/index.html", download_page(release))
    write(out, "privacy/index.html", privacy_page())
    write(out, "contribute/index.html", contribute_page())
    write(out, "s/index.html", station_page())
    write(out, "l/index.html", list_link_page())
    write(out, "404.html", not_found_page())
    preview(
        out / "assets" / "preview.png",
        "Web radios from around the world",
        "Free, without ads or tracking",
    )

    for lst in lists:
        page = f"l/{lst['id']}/index.html"
        try:
            stations = stations_by_uuid([i["uuid"].lower() for i in lst["items"]])
        except RuntimeError as exc:
            # Radio-Browser down should not hold back the rest of the site (a new release on
            # /download/, say): the list keeps the page published by the last build. A list
            # never built has none, and the build stops.
            print(f"list {lst['id']}: {exc}", file=sys.stderr)
            try:
                write(out, page, published_page(page))
            except urllib.error.URLError as fallback:
                raise RuntimeError(f"list {lst['id']}: no page published yet") from fallback
            print(f"::warning::list {lst['id']}: Radio-Browser down, the published page is kept")
        else:
            write(out, page, published_list_page(lst, stations))
            print(f"list {lst['id']}: {len(stations)} of {len(lst['items'])} stations")
        preview(
            out / "l" / lst["id"] / "preview.png",
            lst["title"],
            curators_text(lst.get("curators", [])) or lst.get("description", ""),
            kicker="Soundfolk · List",
        )

    seen = read_seen(args.seen) if not args.offline else set()
    current = {lst["id"] for lst in lists}
    for list_id in sorted(seen - current):
        write(out, f"l/{list_id}/index.html", removed_list_page(list_id))
        print(f"list {list_id}: no longer published")
    # Published with the site, read back by the next build: no commit on main (§6.5).
    write(out, "lists-seen.txt", "".join(f"{i}\n" for i in sorted(seen | current)))


if __name__ == "__main__":
    main()
