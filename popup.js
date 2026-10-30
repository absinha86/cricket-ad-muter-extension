const DEFAULTS = {
  enabled: true, mode: 'mute', lowerVolume: 10, graceMs: 2000, defaultAdSeconds: 15,
  notifyMatchBack: true, chime: false, alertOnlyWhenAway: true, overlay: true,
};
const HOME = chrome.runtime.getManifest().homepage_url || '';
const REPO_READY = /^https:\/\/github\.com\/[^/]+\/[^/]+/.test(HOME) && !HOME.includes('YOUR_GITHUB_USERNAME');
const BREAK_GAP_MS = 10000;    // ads closer together than this are one break
const RING = 2 * Math.PI * 28; // countdown ring circumference (r=28 in popup.html)
const $ = (id) => document.getElementById(id);

let tab = null;
let site = null;   // the supported site (sites.js) the tab is on, if any
let page = null;   // the tab's path: which match "This match" means
let status = null; // last STATUS reply from the content script
let injected = false;
let scope = 'today';

// History entries from before SonyLIV support have no site; they're all JioHotstar.
const siteOf = (h) => h.site || 'hotstar';
const pageOf = (url) => { try { return new URL(url).pathname; } catch (_) { return null; } };

// ---------- talking to the page ----------

function askOnce(msg) {
  return new Promise((resolve) => {
    if (!tab) return resolve(null);
    chrome.tabs.sendMessage(tab.id, msg, (res) => {
      void chrome.runtime.lastError; // no content script on this page
      resolve(res || null);
    });
  });
}

// If the tab was open before the extension was installed, inject now.
async function ask(msg) {
  const res = await askOnce(msg);
  if (res || injected || !site) return res;
  injected = true;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (_) {
    return null;
  }
  await new Promise(r => setTimeout(r, 300));
  return askOnce(msg);
}

// Unmute this break / mute again / mute now: the content script decides which.
async function toggleSound() {
  await ask({ type: 'TOGGLE_SOUND' });
  refreshStatus();
}

// ---------- formatting ----------

// "CPH000031361_CHATGPT_SID_VS_CAREER_ENG_20" -> { brand: "ChatGPT", extra: "Sid vs Career" }
const KNOWN = { CHATGPT: 'ChatGPT', VS: 'vs' };
const DROP = /^(eng|english|hin|hindi|tam|tamil|tel|telugu|kan|kannada|ben|bengali|mar|marathi|vcta|na|s|hd)$/i;

function prettyWord(w) {
  if (KNOWN[w.toUpperCase()]) return KNOWN[w.toUpperCase()];
  const spaced = w.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2');
  return spaced.split(' ').map(p => (p === p.toUpperCase() ? p[0] + p.slice(1).toLowerCase() : p)).join(' ');
}

function prettyAdName(raw) {
  if (!raw || raw === 'Ad') return { brand: 'Ad', extra: '' };
  const tokens = raw.split(/[_\s]+/).filter(t =>
    t &&
    !/^(CPH|PR)[-\d]/i.test(t) &&                  // campaign ids
    !/^\d+$/.test(t) &&                            // lengths, dates
    !/^[A-Z]{2,4}vs[A-Z]{2,4}\d*$/i.test(t) &&     // match codes like INDvsWI26
    !/^(TATA)?IPL\d*/i.test(t) &&
    !/\d+s(Eng|Hin|$)/i.test(t) &&                 // creative codes like SWGIndvWIEmo10sENG
    !DROP.test(t));
  if (!tokens.length) return { brand: 'Ad', extra: '' };
  return { brand: prettyWord(tokens[0]), extra: tokens.slice(1, 4).map(prettyWord).join(' ') };
}

function fmtDuration(sec) {
  sec = Math.round(sec);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const fmtClock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------- status card ----------

// actions: [{ label, run, kind? }], a row of buttons; kind 'secondary' is the quieter style.
function setStatus(state, title, detail, actions = []) {
  $('status').dataset.state = state;
  $('statusTitle').textContent = title;
  $('statusDetail').textContent = detail || '';
  $('statusDetail').title = detail || '';
  // Rebuilt every second, so keep the buttons (and focus) when nothing changed.
  const box = $('statusActions');
  const key = actions.map((a) => `${a.kind}:${a.label}`).join('|');
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.textContent = '';
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.className = `action ${a.kind || ''}`;
      btn.textContent = a.label;
      if (a.title) btn.title = a.title;
      box.appendChild(btn);
    }
  }
  [...box.children].forEach((btn, i) => { btn.onclick = actions[i].run; });
  box.hidden = !actions.length;
  if (state !== 'ad' && state !== 'heard') $('status').classList.remove('untimed', 'manual');
}

async function requestAccess(sites) {
  // The permission prompt may close the popup; the background worker picks
  // up the grant either way.
  const granted = await chrome.permissions.request({ origins: sites.flatMap(siteOrigins) }).catch(() => false);
  if (granted) refreshStatus();
}

// The accent, chip, "This match" and the ad list follow the site the tab is on.
function renderSite() {
  document.body.dataset.site = site?.id || '';
  $('sub').hidden = !!site; // the chip says where we are; the tagline won't fit beside it
  $('siteChip').hidden = !site;
  $('siteChip').textContent = site?.name || '';
  $('scope').querySelector('[data-scope="match"]').hidden = !site;
  if (!site && scope === 'match') scope = 'today';
  renderScope();
}

async function refreshStatus() {
  try { tab = await chrome.tabs.get(tab.id); } catch (_) { /* keep last */ }
  const was = site, wasPage = page;
  site = siteForUrl(tab?.url);
  page = site ? pageOf(tab.url) : null;
  if (site !== was) renderSite();
  else if (page !== wasPage) renderHistory();

  if (!site) {
    status = null;
    if (!(await grantedSites()).length) {
      return setStatus('waiting', 'One step left', `Allow access to ${siteList(SITES, 'and')} so ads can be detected. It works on no other site.`, [
        { label: 'Allow access', run: () => requestAccess(SITES) },
      ]);
    }
    return setStatus('idle', `Not on ${siteList(SITES)}`, 'Open a live match and ads will be muted automatically.',
      SITES.map((s) => ({ label: `Open ${s.name}`, run: () => chrome.tabs.create({ url: s.home }) })));
  }

  if (!(await chrome.permissions.contains({ origins: siteOrigins(site) }))) {
    status = null;
    return setStatus('waiting', 'One step left', `Allow access to ${site.name} so its ads can be detected. It works on no other site.`, [
      { label: `Allow access to ${site.name}`, run: () => requestAccess([site]) },
    ]);
  }
  if (!$('enabled').checked) {
    status = null;
    return setStatus('paused', 'Paused', 'Ads will play with sound.', [{ label: 'Resume', run: () => setEnabled(true) }]);
  }

  status = await ask({ type: 'STATUS' });
  if (!status) {
    return setStatus('waiting', 'Connecting…', 'The page isn’t responding.', [
      { label: 'Reload tab', run: () => chrome.tabs.reload(tab.id) },
    ]);
  }
  if (!status.hasVideo) return setStatus('waiting', 'Waiting for video', 'Start a match and ads will be handled.');
  if (status.isAd) return renderBreak();
  if (status.resuming) return setStatus('waiting', 'Match coming back…', 'The ads are over; the stream is reloading.');

  const userMuted = tab.mutedInfo?.muted && tab.mutedInfo.reason === 'user';
  setStatus('live', 'Match audio on', userMuted ? 'Tab is muted by you' : `Listening for ${site.name} ads…`, userMuted ? [] : [{
    label: status.mode === 'lower' ? 'Turn down now' : 'Mute now', run: toggleSound, kind: 'secondary',
    title: 'For an ad that wasn’t caught. Press again (or the badge on the video) when the match is back.',
  }]);
}

function renderBreak() {
  const lower = status.mode === 'lower';
  if (status.manual) {
    setStatus('ad', lower ? 'Turned down by you' : 'Muted by you', 'Unmute when the match is back.', [
      { label: lower ? 'Full volume' : 'Unmute', run: toggleSound },
    ]);
  } else {
    // SonyLIV's player shows no ad names.
    const { brand, extra } = prettyAdName(status.adName);
    const name = !status.adName ? `${site.name} ad break` : extra ? `${brand} · ${extra}` : brand;
    if (status.heard) {
      setStatus('heard', 'Sound on for this break', name, [{ label: lower ? 'Turn down again' : 'Mute again', run: toggleSound }]);
    } else {
      setStatus('ad', lower ? 'Ad turned down' : 'Ad muted', name, [
        { label: lower ? 'Full volume for this break' : 'Unmute this break', run: toggleSound },
      ]);
    }
  }
  tickCountdown();
}

// Runs more often than refreshStatus so the ring moves smoothly.
function tickCountdown() {
  if (!status?.isAd) return;
  const untimed = status.manual || !status.adEndsAt;
  $('status').classList.toggle('untimed', untimed);
  $('status').classList.toggle('manual', !!status.manual);
  if (untimed) {
    $('countdown').textContent = status.manual ? '🔇' : 'AD';
    $('ringArc').style.strokeDashoffset = '';
    return;
  }
  const left = (status.adEndsAt - Date.now()) / 1000;
  const frac = Math.max(0, Math.min(1, left / (status.adSeconds || 1)));
  $('countdown').textContent = left > 0 ? `${Math.ceil(left)}s` : '…';
  $('ringArc').style.strokeDashoffset = String(RING * (1 - frac));
  if (left <= 0 && !status.heard) $('statusDetail').textContent = 'Checking for another ad…';
}

// ---------- history / stats ----------

// Back-to-back ads (each starting within a few seconds of the last one
// ending) are one break. Entries are oldest first; so are the breaks.
function toBreaks(entries) {
  const breaks = [];
  for (const h of entries) {
    const b = breaks[breaks.length - 1];
    const manual = !!h.manual;
    if (b && b.manual === manual && !manual && b.site === siteOf(h) && h.t - b.end <= BREAK_GAP_MS) {
      b.ads.push(h);
      b.end = Math.max(b.end, h.t + h.seconds * 1000);
      b.seconds += h.seconds;
    } else {
      breaks.push({ site: siteOf(h), t: h.t, end: h.t + h.seconds * 1000, seconds: h.seconds, ads: [h], manual });
    }
  }
  return breaks;
}

function inScope(h) {
  if (site && siteOf(h) !== site.id) return false;
  if (scope === 'match') return !!h.page && h.page === page;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return h.t >= (scope === 'today' ? start.getTime() : Date.now() - 7 * 86400000);
}

function breakRow(b) {
  const li = document.createElement('li');
  li.title = b.ads.map((h) => h.name).join('\n');
  if (b.manual) li.classList.add('manual');
  const names = [...new Set(b.ads.map((h) => prettyAdName(h.name).brand).filter((n) => n !== 'Ad'))];
  const title = b.manual ? 'Muted by you'
    : names.length ? names.slice(0, 2).join(' · ') + (names.length > 2 ? ` +${names.length - 2}` : '')
    : 'Ad break';
  const sub = [b.manual ? 'Missed ad?' : plural(b.ads.length, 'ad'), !site && siteById(b.site)?.name].filter(Boolean).join(' · ');

  const time = document.createElement('span'); time.className = 'ad-time'; time.textContent = fmtClock(b.t);
  const main = document.createElement('span'); main.className = 'ad-main';
  const name = document.createElement('span'); name.className = 'ad-name'; name.textContent = title;
  const subEl = document.createElement('span'); subEl.className = 'ad-sub'; subEl.textContent = sub;
  main.append(name, subEl);
  const guessed = b.ads.some((h) => h.guessed);
  const chip = document.createElement('span'); chip.className = guessed ? 'chip guess' : 'chip';
  chip.textContent = fmtDuration(b.seconds);
  if (guessed) chip.title = 'Some lengths weren’t known; used the default';
  li.append(time, main, chip);
  return li;
}

async function renderHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  const breaks = toBreaks(history.filter(inScope));
  const adBreaks = breaks.filter((b) => !b.manual);
  const ads = adBreaks.reduce((n, b) => n + b.ads.length, 0);
  $('statBreaks').textContent = adBreaks.length;
  $('statBreaksLbl').textContent = adBreaks.length === 1 ? 'break' : 'breaks';
  $('statAds').textContent = ads;
  $('statAdsLbl').textContent = ads === 1 ? 'ad' : 'ads';
  $('statTime').textContent = fmtDuration(adBreaks.reduce((n, b) => n + b.seconds, 0));

  const list = $('recent');
  list.textContent = '';
  for (const b of breaks.slice(-6).reverse()) list.appendChild(breakRow(b));
  $('recentEmpty').hidden = breaks.length > 0;
  $('recentEmpty').textContent = {
    match: 'No ad breaks yet this match.',
    today: 'No ad breaks yet today.',
    week: 'No ad breaks in the last 7 days.',
  }[scope];
}

function renderScope() {
  for (const b of $('scope').querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.scope === scope));
  renderHistory();
}

// ---------- settings (autosave) ----------

let savedTimer;
function flashSaved() {
  $('saved').classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => $('saved').classList.remove('show'), 1200);
}

async function save(patch) {
  await chrome.storage.sync.set(patch);
  flashSaved();
}

function renderMode(mode) {
  for (const b of document.querySelectorAll('.segmented button')) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  $('lowerRow').hidden = mode !== 'lower';
}

function renderRangeLabels() {
  $('lowerVolumeVal').textContent = `${$('lowerVolume').value}%`;
  $('graceVal').textContent = `${(Number($('graceMs').value) / 1000).toFixed(1)}s`;
  $('defaultAdSecondsVal').textContent = `${$('defaultAdSeconds').value}s`;
}

const TOGGLES = ['notifyMatchBack', 'chime', 'alertOnlyWhenAway', 'overlay'];
const RANGES = ['lowerVolume', 'graceMs', 'defaultAdSeconds'];

async function loadSettings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $('enabled').checked = s.enabled;
  renderMode(s.mode);
  for (const k of RANGES) $(k).value = s[k];
  for (const k of TOGGLES) $(k).checked = s[k];
  renderRangeLabels();
}

async function setEnabled(on) {
  $('enabled').checked = on;
  await chrome.storage.sync.set({ enabled: on });
  setTimeout(refreshStatus, 150);
}

// Each site, and whether it's allowed; allowing one restarts the extension
// (see background.js), which closes the popup.
async function renderSites() {
  const granted = await grantedSites();
  const box = $('sites');
  box.textContent = '';
  for (const s of SITES) {
    const row = document.createElement('div'); row.className = 'site-row';
    const text = document.createElement('span');
    const t = document.createElement('span'); t.className = 't'; t.textContent = s.name;
    const d = document.createElement('span'); d.className = 'd'; d.textContent = s.pages.map((p) => p.replace(/^\*:\/\/\*\.|\/\*$/g, '')).join(', ');
    text.append(t, d);
    row.append(text);
    if (granted.includes(s)) {
      const ok = document.createElement('span'); ok.className = 'allowed'; ok.textContent = '✓ Allowed';
      row.append(ok);
    } else {
      const btn = document.createElement('button'); btn.className = 'small primary'; btn.textContent = 'Allow';
      btn.onclick = () => requestAccess([s]);
      row.append(btn);
    }
    box.append(row);
  }
}

function showSettings(on) {
  $('mainView').hidden = on;
  $('settingsView').hidden = !on;
  if (on) { renderSites(); renderRules(); $('closeSettings').focus(); } else $('openSettings').focus();
}

// The shortcuts as the user has them set (chrome://extensions/shortcuts).
async function renderKeys() {
  const cmds = await chrome.commands.getAll().catch(() => []);
  const keyOf = (name) => cmds.find((c) => c.name === name)?.shortcut || '';
  const box = $('keys');
  box.textContent = '';
  for (const [name, what] of [['toggle-enabled', 'pause'], ['toggle-ad-sound', 'sound']]) {
    const key = keyOf(name);
    if (!key) continue;
    const item = document.createElement('span');
    key.split('+').forEach((k, i) => {
      if (i) item.append('+');
      const kbd = document.createElement('kbd'); kbd.textContent = k;
      item.append(kbd);
    });
    item.append(` ${what}`);
    box.append(item);
  }
  const pause = keyOf('toggle-enabled');
  $('enabledSwitch').title = pause ? `Pause / resume (${pause})` : 'Pause / resume';
}

// ---------- rules / report ----------

async function renderRules(info) {
  info = info || await chrome.runtime.sendMessage({ type: 'RULES_INFO' }).catch(() => null);
  if (!info) { $('rulesInfo').textContent = 'Unavailable'; return; }
  let line = `v${info.version} (${info.source})`;
  if (!info.onlineConfigured) line += ' · online updates off';
  else if (info.check?.ok) line += ` · checked ${fmtAgo(info.check.t)}`;
  else if (info.check) line += ` · update failed ${fmtAgo(info.check.t)}`;
  $('rulesInfo').textContent = line;
  $('rulesInfo').title = info.check?.error || '';
  $('rulesRefresh').disabled = !info.onlineConfigured;
}

async function reportProblem() {
  const [{ history = [] }, rules] = await Promise.all([
    chrome.storage.local.get('history'),
    chrome.runtime.sendMessage({ type: 'RULES_INFO' }).catch(() => null),
  ]);
  const s = await chrome.storage.sync.get(DEFAULTS);
  const chromeVer = (navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1] || '?';
  // How long ago, not the date and time: the issue is public.
  const recent = history.slice(-8).map(h => `- ${fmtAgo(h.t)} ${siteById(siteOf(h))?.name} \`${h.name}\` ${h.seconds}s${h.guessed ? ' (default length)' : ''}${h.manual ? ' (muted by hand: a missed ad?)' : ''}`).join('\n') || '- none';
  const body = [
    '**What happened?**', '<!-- e.g. an ad played with sound, or the match stayed muted -->', '', '',
    '**About your setup** (filled in automatically, nothing else is shared)',
    `- Extension: ${chrome.runtime.getManifest().version}`,
    `- Site: ${site?.name ?? 'not on a match site'}`,
    `- Rules: v${rules?.version ?? '?'} (${rules?.source ?? '?'})`,
    `- Chrome: ${chromeVer}`,
    `- Mode: ${s.mode}, gap between ads: ${s.graceMs} ms`,
    '', '**Last ads detected**', recent,
  ].join('\n');
  const url = `${HOME.replace(/\/$/, '')}/issues/new?title=${encodeURIComponent('Problem: ')}&body=${encodeURIComponent(body)}`;
  chrome.tabs.create({ url });
}

// ---------- wiring ----------

$('enabled').addEventListener('change', (e) => setEnabled(e.target.checked));
$('openSettings').addEventListener('click', () => showSettings(true));
$('closeSettings').addEventListener('click', () => showSettings(false));

for (const b of $('scope').querySelectorAll('button')) {
  b.addEventListener('click', () => { scope = b.dataset.scope; renderScope(); });
}

for (const b of document.querySelectorAll('.segmented button')) {
  b.addEventListener('click', () => { renderMode(b.dataset.mode); save({ mode: b.dataset.mode }); });
}

for (const id of RANGES) {
  $(id).addEventListener('input', renderRangeLabels);
  $(id).addEventListener('change', () => save({ [id]: Number($(id).value) }));
}
for (const id of TOGGLES) {
  $(id).addEventListener('change', () => save({ [id]: $(id).checked }));
}

$('rulesRefresh').addEventListener('click', async () => {
  const btn = $('rulesRefresh');
  btn.disabled = true; btn.textContent = 'Checking…';
  const info = await chrome.runtime.sendMessage({ type: 'RULES_REFRESH' }).catch(() => null);
  btn.textContent = 'Check now';
  renderRules(info);
});

$('resetStats').addEventListener('click', async () => {
  const btn = $('resetStats');
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1'; btn.textContent = 'Tap again to reset';
    setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = 'Reset stats'; }, 3000);
    return;
  }
  btn.dataset.confirm = ''; btn.textContent = 'Reset stats';
  await chrome.storage.local.set({ history: [] });
});

$('report').addEventListener('click', reportProblem);
if (!REPO_READY) { $('report').disabled = true; $('report').title = 'Project page not set up yet'; }

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.history) renderHistory();
  if (area === 'sync' && changes.enabled) { $('enabled').checked = changes.enabled.newValue; refreshStatus(); }
});

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  site = siteForUrl(tab?.url);
  page = site ? pageOf(tab.url) : null;
  scope = site ? 'match' : 'today';
  await loadSettings();
  renderSite();
  renderKeys();
  await refreshStatus();
  setInterval(refreshStatus, 1000);
  setInterval(tickCountdown, 250);
})();
