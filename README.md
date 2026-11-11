# getsoundfolk.github.io

Soundfolk's website, at <https://getsoundfolk.github.io>: the pages that share links open, and
getting the app. The design is in the app's repository,
[docs/16-sharing.md](https://github.com/getsoundfolk/soundfolk/blob/main/docs/16-sharing.md) §5.

| Address | What |
|---|---|
| `/` | Home: what Soundfolk does, with screenshots of the app, Get Soundfolk, the published lists |
| `/download/` | The packages of the latest release, for each system, and how to install them |
| `/privacy/` | What the app sends, to whom, and how to turn it off |
| `/contribute/` | Recipes, donation links, lists, code |
| `/s/#…` | A station shared from the app: listen in the page, Open in Soundfolk |
| `/l/<id>/` | A list published in [soundfolk-stations](https://github.com/getsoundfolk/soundfolk-stations), with its stations written in (and a preview image for chat apps) |
| `/l/#…` | A listener's own list, or a published list newer than the last build |
| `/soundfolk-stations/` | soundfolk-stations' own site (its repository, not this one) |

What a link carries is after `#`: it never reaches GitHub, only the visitor's browser.

## Rules

* Plain HTML, CSS and JavaScript modules, no framework, no third-party script, no analytics,
  no cookies. A strict Content-Security-Policy on every page (`templates/base.html`).
* Texts from a link or from Radio-Browser are set as text, never as HTML.
* The page plays only catalog stations, from Radio-Browser's address, never an address from a
  link (§6.4).
* `site/assets/link.js` reads links like the app's `src-tauri/src/share.rs`: change both together.

## Building

```sh
python3 -m pip install pillow     # the preview images
python3 scripts/build.py -o _site # or --offline: no lists, no release
python3 -m http.server -d _site
node --test scripts/test_link.mjs
```

`site/` is copied as it is; `scripts/build.py` writes the pages from `templates/base.html` and
`templates/pages/`, a page per published list, the preview images and `release.json`. The Pages
workflow builds and publishes on every push to `main`, every day and by hand. It writes nothing to the repository: the ids of the
lists ever built (to keep a page for removed ones) are published in `/lists-seen.txt` and read back
by the next build.

## Screenshots

`site/assets/shots/<name>-dark.webp` and `<name>-light.webp`, of the same size: the page shows the
one matching the visitor's theme. Take them from a Soundfolk with its own data folders (not your
own history), at a scale of 2, and keep what the app shows true to the current version.

## License

[MPL-2.0](LICENSE), like the app.
