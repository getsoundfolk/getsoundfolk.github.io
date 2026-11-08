// SPDX-License-Identifier: MPL-2.0
// 404.html: GitHub Pages serves it for any address it does not have. A list published since the
// site's last build has no page yet: /l/<id>/ goes to /l/#<id>, which reads lists.json
// (soundfolk docs/16-sharing.md §5.4). Anything else is a page not found.
import { isListId } from './link.js';
import { setUpGet } from './page.js';

const list = location.pathname.match(/^\/l\/([^/]+)\/?$/);
if (list && isListId(list[1])) {
  const extra = location.hash.replace(/^#/, '');
  location.replace(`/l/#id=${list[1]}${extra ? `&${extra}` : ''}`);
} else {
  setUpGet();
}
