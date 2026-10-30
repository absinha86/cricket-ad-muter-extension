// Cricket Ad Muter: background service worker.
//
// Mutes the tab during ad breaks on the sites in sites.js. On JioHotstar it
// spots each ad from the page's ad tracking request (each ad fires one as it
// starts, and its name carries its length) and hands the timing to the
// content script. On SonyLIV the content script spots ads itself, from the
// player's own ad marker. Either way the content script says when the break
// is over.
//
// Detection patterns live in rules.json: the bundled copy, overridden by a
// newer copy fetched from the project's GitHub repo, so a site change can
// be fixed without a store release. The rules are data only (regex strings),
// never code.
//
// MV3 workers are killed when idle and woken by events, so anything an event
// handler needs (settings, rules) is awaited through a ready promise, and
// "did we mute this tab?" is read back from tab.mutedInfo, not memory.

importScripts('sites.js');

const DEFAULTS = {
  enabled: true,
  mode: 'mute',            // 'mute' | 'lower'
  lowerVolume: 10,         // % of normal volume in 'lower' mode
  graceMs: 2000,           // wait after an ad ends for the next one before unmuting
  defaultAdSeconds: 15,    // when the ad name carries no length
  notifyMatchBack: true,   // desktop notification when the break ends
  chime: false,            // also play a short sound
  alertOnlyWhenAway: true, // only alert if the match tab isn't in view
};
const HISTORY_MAX = 200;
const RULES_ALARM = 'refresh-rules';
const RULES_REFRESH_MIN = 6 * 60;

// ---------- settings ----------

let settings = { ...DEFAULTS };
const settingsReady = chrome.storage.sync.get(DEFAULTS).then((s) => {
  settings = { ...DEFAULTS, ...s };
  setGlobalIcon(settings.enabled);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue ?? DEFAULTS[k];
  if ('enabled' in changes) setGlobalIcon(settings.enabled);
});

// ---------- detection rules ----------

let rules = null;     // compiled
let rulesInfo = null; // { version, updated, source }

// A rules file comes from the network, so its limits are kept within sane
// bounds: whatever it says, no ad or stuck marker mutes a tab for long.
const clamp = (v, min, max, fallback) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);

function compileRules(raw) {
  if (!raw || !Number.isInteger(raw.version) || !Array.isArray(raw.adPings) || !raw.adPings.length) {
    throw new Error('invalid rules file');
  }
  return {
    version: raw.version,
    pings: raw.adPings.map((p) => ({
      site: p.site || 'hotstar', // rules files before SonyLIV support had no site
      host: new RegExp(p.host, 'i'),
      path: new RegExp(p.path, 'i'),
      nameParams: Array.isArray(p.nameParams) ? p.nameParams : ['adName'],
    })),
    durationParams: raw.durationParams || [],
    durationRes: (raw.durationPatterns || []).map((s) => new RegExp(s, 'i')),
    maxAdSeconds: clamp(raw.maxAdSeconds, 30, 300, 180),
    // Page elements that show while an ad plays; the content script watches them.
    markers: (raw.adMarkers || []).filter((m) => m?.site && typeof m.selector === 'string')
      .map((m) => ({ site: m.site, selector: m.selector, timer: m.timer || null, playing: !!m.playing })),
    maxMarkerSeconds: clamp(raw.maxMarkerSeconds, 60, 900, 600),
  };
}

async function loadRules() {
  const bundled = await (await fetch(chrome.runtime.getURL('rules.json'))).json();
  const { remoteRules } = await chrome.storage.local.get('remoteRules');
  if (remoteRules?.data?.version > bundled.version) {
    try {
      rules = compileRules(remoteRules.data);
      rulesInfo = { version: remoteRules.data.version, updated: remoteRules.data.updated, source: 'online' };
      return;
    } catch (_) { /* fall back to bundled */ }
  }
  rules = compileRules(bundled);
  rulesInfo = { version: bundled.version, updated: bundled.updated, source: 'built-in' };
}
let rulesReady = loadRules();

// https://github.com/<user>/<repo> -> raw rules.json on the main branch.
function remoteRulesUrl() {
  const home = chrome.runtime.getManifest().homepage_url || '';
  const m = home.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/);
  if (!m || m[1] === 'YOUR_GITHUB_USERNAME') return null;
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/main/rules.json`;
}

async function refreshRemoteRules() {
  const url = remoteRulesUrl();
  let check;
  if (!url) {
    check = { t: Date.now(), ok: false, error: 'Online updates not set up' };
  } else {
    try {
      const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      compileRules(data); // validate before storing
      await chrome.storage.local.set({ remoteRules: { data, fetchedAt: Date.now() } });
      rulesReady = loadRules();
      await rulesReady;
      check = { t: Date.now(), ok: true };
    } catch (e) {
      check = { t: Date.now(), ok: false, error: String(e.message || e) };
    }
  }
  await chrome.storage.local.set({ rulesCheck: check });
  return check;
}

chrome.alarms.onAlarm.addListener((a) => { if (a.name === RULES_ALARM) refreshRemoteRules(); });

// ---------- icon / badge ----------

const iconSet = (name) => ({ 16: `icons/${name}-16.png`, 32: `icons/${name}-32.png`, 48: `icons/${name}-48.png` });

async function setTabUi(tabId, isAd, secondsLeft) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#e5484d' });
    await chrome.action.setBadgeText({ tabId, text: !isAd ? '' : secondsLeft > 0 ? String(secondsLeft) : 'AD' });
  } catch (_) { /* tab gone */ }
}

function setGlobalIcon(enabled) {
  chrome.action.setIcon({ path: iconSet(enabled ? 'icon' : 'off') });
  chrome.action.setTitle({ title: enabled ? 'Cricket Ad Muter' : 'Cricket Ad Muter (paused)' });
}

// ---------- mute control ----------

function mutedByUs(tab) {
  const mi = tab.mutedInfo || {};
  return mi.muted && mi.reason === 'extension' && mi.extensionId === chrome.runtime.id;
}

async function getTab(tabId) {
  try { return await chrome.tabs.get(tabId); } catch (_) { return null; }
}

async function mute(tabId) {
  const tab = await getTab(tabId);
  // Never touch a tab the user muted themselves.
  if (tab && !tab.mutedInfo?.muted) await chrome.tabs.update(tabId, { muted: true });
}

async function unmuteIfOurs(tabId) {
  const tab = await getTab(tabId);
  if (tab && mutedByUs(tab)) { await chrome.tabs.update(tabId, { muted: false }); return true; }
  return false;
}

// tabId -> end time of the latest detected ad. Lets us drop a stale "break
// over" from the content script that crossed paths with a new ad's request.
const adUntil = new Map();
// Tabs whose user turned the sound on for the current break, so the next
// ad's request in it doesn't mute again.
const heardTabs = new Set();

async function handleAdState(tabId, { isAd, heard, mode }) {
  await settingsReady;
  if (isAd) {
    if (heard) heardTabs.add(tabId); else heardTabs.delete(tabId);
    // In 'lower' mode the content script turns the video down itself.
    if (heard || mode === 'lower') await unmuteIfOurs(tabId);
    else await mute(tabId);
    setTabUi(tabId, true);
    return;
  }
  heardTabs.delete(tabId);
  if (Date.now() < (adUntil.get(tabId) || 0)) return;
  await unmuteIfOurs(tabId);
  setTabUi(tabId, false);
}

// ---------- "match is back" alert ----------

// visible: the match page is on screen (from the page itself). "Away" means
// it isn't: another tab in front, or the window minimized or covered. Chrome
// merely not being the focused app (say the user is watching while typing
// elsewhere) isn't away; the badge on the video already says the match is back.
async function alertMatchBack(tabId, visible) {
  if (!settings.notifyMatchBack && !settings.chime) return;
  const tab = await getTab(tabId);
  if (!tab) return;
  if (settings.alertOnlyWhenAway) {
    let focused = false;
    try { focused = (await chrome.windows.get(tab.windowId)).focused; } catch (_) {}
    if (visible || (tab.active && focused)) return;
  }
  if (settings.notifyMatchBack) {
    const site = siteForUrl(tab.url);
    chrome.notifications.create(`match-back:${tabId}`, {
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: 'The match is back',
      message: site ? `Ads are over on ${site.name} and the sound is on.` : 'Ads are over and the sound is on.',
      priority: 1,
    });
  }
  if (settings.chime) chrome.tabs.sendMessage(tabId, { type: 'CHIME' }).catch(() => {});
}

chrome.notifications.onClicked.addListener(async (id) => {
  const m = id.match(/^match-back:(\d+)$/);
  chrome.notifications.clear(id);
  if (!m) return;
  const tab = await getTab(Number(m[1]));
  if (!tab) return;
  chrome.tabs.update(tab.id, { active: true });
  chrome.windows.update(tab.windowId, { focused: true });
});

// ---------- ad detection ----------

function adDurationSec(url, adName) {
  for (const k of rules.durationParams) {
    const v = parseFloat(url.searchParams.get(k));
    if (v > 0) return v > 1000 ? v / 1000 : v; // tolerate ms
  }
  if (adName) {
    for (const re of rules.durationRes) {
      const m = adName.match(re);
      if (m) return parseInt(m[1], 10);
    }
  }
  return null;
}

// Returns { site, name, seconds } if this request marks the start of an ad.
function classifyAdRequest(url) {
  for (const p of rules.pings) {
    if (!p.host.test(url.hostname) || !p.path.test(url.pathname)) continue;
    const name = p.nameParams.map((k) => url.searchParams.get(k)).find(Boolean) || null;
    return { site: p.site, name, seconds: adDurationSec(url, name) };
  }
  return null;
}

// The match an ad belongs to: the page it played on (its path, without the query).
function pageOf(url) {
  try { return new URL(url).pathname; } catch (_) { return null; }
}

async function recordAd(entry) {
  const { history = [] } = await chrome.storage.local.get('history');
  history.push(entry);
  await chrome.storage.local.set({ history: history.slice(-HISTORY_MAX) });
}

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.tabId < 0) return;
  onRequest(details);
}, { urls: ALL_ORIGINS });

async function onRequest(details) {
  await Promise.all([settingsReady, rulesReady]);
  let url;
  try { url = new URL(details.url); } catch (_) { return; }
  const ad = classifyAdRequest(url);
  if (!ad || !settings.enabled) return;
  const tabId = details.tabId;
  // An ad domain can be shared between sites, so check the tab is on the
  // site the rule is for.
  const tab = await getTab(tabId);
  if (!tab || siteForUrl(tab.url)?.id !== ad.site) return;

  const now = Date.now();
  const seconds = Math.min(rules.maxAdSeconds, Math.max(3, ad.seconds || settings.defaultAdSeconds));
  adUntil.set(tabId, now + seconds * 1000);

  // Mute here rather than waiting for the content script round trip, so a
  // new ad in a break never gets a moment of sound.
  if (settings.mode !== 'lower' && !heardTabs.has(tabId)) mute(tabId);
  setTabUi(tabId, true, seconds);
  recordAd({ t: now, site: ad.site, page: pageOf(tab.url), name: ad.name || 'Ad', seconds, guessed: !ad.seconds });
  chrome.tabs.sendMessage(tabId, { type: 'NET_AD', name: ad.name, seconds, until: now + seconds * 1000 })
    .catch(() => injectInto(tabId)); // page predates install: inject, next ad will be caught
}

chrome.tabs.onRemoved.addListener((tabId) => { adUntil.delete(tabId); heardTabs.delete(tabId); });

// ---------- messages ----------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab?.id;
  switch (msg?.type) {
    case 'AD_STATE':
      if (tabId != null) handleAdState(tabId, { isAd: !!msg.isAd, heard: !!msg.heard, mode: msg.mode });
      break;
    case 'MATCH_BACK': // a break ended and the match is playing again
      if (tabId != null) alertMatchBack(tabId, !!msg.visible);
      break;
    case 'AD_TICK':
      if (tabId != null) setTabUi(tabId, true, msg.secondsLeft);
      break;
    case 'PAGE_RULES': {
      const site = siteForUrl(sender.url);
      rulesReady.then(() => reply({
        markers: rules.markers.filter((m) => m.site === site?.id),
        maxMarkerSeconds: rules.maxMarkerSeconds,
      }));
      return true;
    }
    // Once it's over: an ad seen through a page marker, or the user's own
    // "Mute now" (manual), which usually means an ad we missed.
    case 'LOG_AD':
      if (tabId != null) {
        recordAd({
          t: msg.t, site: siteForUrl(sender.url)?.id, page: pageOf(sender.url),
          name: msg.manual ? 'Muted by you' : 'Ad', seconds: msg.seconds, guessed: false, manual: !!msg.manual,
        });
      }
      break;
    case 'RULES_INFO':
      rulesReady.then(async () => {
        const { rulesCheck = null } = await chrome.storage.local.get('rulesCheck');
        reply({ ...rulesInfo, check: rulesCheck, onlineConfigured: !!remoteRulesUrl() });
      });
      return true; // async reply
    case 'RULES_REFRESH':
      refreshRemoteRules().then(async (check) => {
        await rulesReady;
        reply({ ...rulesInfo, check, onlineConfigured: !!remoteRulesUrl() });
      });
      return true;
  }
});

// Page reload / navigation during an ad would otherwise leave the tab muted.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'loading' && mutedByUs(tab)) {
    chrome.tabs.update(tabId, { muted: false });
    setTabUi(tabId, false);
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'toggle-enabled') {
    await settingsReady;
    await chrome.storage.sync.set({ enabled: !settings.enabled });
  } else if (command === 'toggle-ad-sound') {
    // Unmute this break / mute now, on the match tab in front.
    tab = tab || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (tab && siteForUrl(tab.url)) chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SOUND' }).catch(() => {});
  }
});

// ---------- site access / install / startup ----------
//
// Access to each site is an optional permission the user grants from the
// welcome page or popup, so the install prompt asks for no site access.
// The content script can't be declared in the manifest (that would force the
// permission at install), so it's registered here for the granted sites.

const CONTENT_SCRIPT_ID = 'cam-content';

function injectInto(tabId) {
  return chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {});
}

// Several start-up paths (worker start, onInstalled, onStartup, permission
// changes) call this at once; run them one at a time so two of them can't
// both see "not registered" and register twice ("Duplicate script ID").
let syncQueue = Promise.resolve();
function syncContentScript() {
  const run = syncQueue.then(doSyncContentScript);
  syncQueue = run.catch(() => {});
  return run;
}

// Returns the granted sites.
async function doSyncContentScript() {
  const granted = await grantedSites();
  const matches = granted.flatMap((s) => s.pages);
  const [current] = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  if (current && String(current.matches) === String(matches)) return granted;
  if (current) await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  if (matches.length) {
    await chrome.scripting.registerContentScripts([{
      id: CONTENT_SCRIPT_ID,
      matches,
      js: ['content.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    }]);
  }
  return granted;
}

// Registered scripts only load on pages opened afterwards, so also inject
// into match tabs that are already open.
async function injectIntoOpenTabs(sites) {
  if (!sites.length) return;
  const tabs = await chrome.tabs.query({ url: sites.flatMap((s) => s.pages) });
  for (const t of tabs) injectInto(t.id);
}

// The webRequest listener above is registered when the worker starts. With no
// site allowed yet, Chrome rejects it ("You need to request host permissions
// in the manifest…"), and allowing one later doesn't retry. So when the first
// site is allowed, restart the extension: the listener then registers with
// access in place. Once registered, Chrome checks access per request, so
// allowing another site later needs no restart (a restart closes the popup
// and cuts off any ad break in progress). After the restart we bring the user
// to a tab on the site they just allowed, or confirm on the welcome page if
// they don't have one open.
const accessAtStart = grantedSites().then((sites) => sites.length > 0);

chrome.permissions.onAdded.addListener(async ({ origins = [] }) => {
  const granted = await grantedSites();
  if (!granted.length) return;
  const added = granted.filter((s) => siteOrigins(s).some((o) => origins.includes(o)));
  if (await accessAtStart) {
    await syncContentScript();
    injectIntoOpenTabs(added.length ? added : granted); // a live copy ignores a second injection
    return;
  }
  await chrome.storage.local.set({ justGranted: (added.length ? added : granted).map((s) => s.id) });
  chrome.runtime.reload();
});
chrome.permissions.onRemoved.addListener(() => syncContentScript());

// Every worker start: make sure the content script matches the current
// access, and finish the post-grant restart if that's why we're starting.
(async () => {
  const granted = await syncContentScript();
  const { justGranted } = await chrome.storage.local.get('justGranted');
  if (!justGranted) return;
  await chrome.storage.local.remove('justGranted');
  if (!granted.length) return;
  injectIntoOpenTabs(granted);
  const added = granted.filter((s) => justGranted.includes(s.id));
  const tab = await pickMatchTab(added.length ? added : granted);
  if (tab) {
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });
  } else {
    chrome.tabs.create({ url: 'welcome.html#ready' });
  }
})();

// Prefer a match page, then whichever tab on these sites was used most recently.
async function pickMatchTab(sites) {
  const tabs = await chrome.tabs.query({ url: sites.flatMap((s) => s.pages) });
  if (!tabs.length) return null;
  const score = (t) => (siteForUrl(t.url)?.watchRe.test(t.url) ? 1e15 : 0) + (t.lastAccessed || 0);
  return tabs.sort((a, b) => score(b) - score(a))[0];
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const granted = await syncContentScript();
  // An update or reload cut off the content scripts timing any ad break in
  // progress, so nothing would unmute those tabs. Unmute them; the copies
  // injected next mute again if an ad is still on.
  for (const t of await chrome.tabs.query({ muted: true })) {
    if (mutedByUs(t)) chrome.tabs.update(t.id, { muted: false });
  }
  injectIntoOpenTabs(granted);
  // First install: walk the user through granting access.
  if (reason === 'install' && !granted.length) chrome.tabs.create({ url: 'welcome.html' });
  chrome.alarms.create(RULES_ALARM, { periodInMinutes: RULES_REFRESH_MIN });
  refreshRemoteRules();
});

chrome.runtime.onStartup.addListener(() => {
  syncContentScript();
  chrome.alarms.create(RULES_ALARM, { periodInMinutes: RULES_REFRESH_MIN });
  refreshRemoteRules();
});
