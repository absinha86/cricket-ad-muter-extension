// Cricket Ad Muter: the streaming sites it works on. Shared by the background
// worker (importScripts) and the popup and welcome pages (<script>).
//
// Adding a site: list it here, add its `pages` and `hosts` to manifest.json's
// optional_host_permissions, and add its ad request to rules.json.

const SITES = [
  {
    id: 'hotstar',
    name: 'JioHotstar',
    pages: ['*://*.hotstar.com/*', '*://*.jiohotstar.com/*'], // where matches play
    hosts: [],                                                // other domains its ad requests go to
    hostRe: /(^|\.)(jio)?hotstar\.com$/i,
    watchRe: /\/watch\b/,
    home: 'https://www.hotstar.com/in/sports',
  },
  {
    id: 'sonyliv',
    name: 'SonyLIV',
    pages: ['*://*.sonyliv.com/*'],
    hosts: [],
    hostRe: /(^|\.)sonyliv\.com$/i,
    watchRe: /\/live-sport\/|[?&]watch=true/,
    home: 'https://www.sonyliv.com/',
  },
];

const siteById = (id) => SITES.find((s) => s.id === id) || null;
const siteOrigins = (site) => [...site.pages, ...site.hosts];
const ALL_ORIGINS = SITES.flatMap(siteOrigins);
const ALL_PAGES = SITES.flatMap((s) => s.pages);

function siteForUrl(url) {
  let host;
  try { host = new URL(url).hostname; } catch (_) { return null; }
  return SITES.find((s) => s.hostRe.test(host)) || null;
}

// Sites the user has granted access to. Each site is all-or-nothing: its
// pages and its ad hosts are requested together.
async function grantedSites() {
  const ok = await Promise.all(SITES.map((s) => chrome.permissions.contains({ origins: siteOrigins(s) })));
  return SITES.filter((_, i) => ok[i]);
}

// Names in a sentence: "JioHotstar", "JioHotstar or SonyLIV", "A, B or C".
function siteList(sites, joiner = 'or') {
  const n = sites.map((s) => s.name);
  return n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} ${joiner} ${n[n.length - 1]}`;
}
