// Cricket Ad Muter: content script (runs on JioHotstar and SonyLIV pages).
//
// Ads are spotted two ways. On JioHotstar the background worker sees each
// ad's tracking request and tells us how long the ad runs. On SonyLIV the
// player marks ads in the page itself (a class on the player while an ad
// plays), which this script watches for; the markers come from rules.json.
//
// This script owns the timing: it keeps the break "on" until the last ad's
// time plus a short grace period has passed (the next ad starts a moment
// after the previous one ends), then reports the break over. In "lower
// volume" mode it also turns the video down itself.
//
// It also owns the sound button (popup, the badge it shows on the video, and
// Alt+Shift+M): during a break it lets the user hear the rest of the break,
// and otherwise it mutes on demand, for an ad that wasn't caught.
(() => {
  // May be injected twice (manifest + on-demand injection); keep one live copy.
  // A copy is dead once the extension is reloaded or removed: it can no longer
  // reach the extension, so it stops and takes its badge with it.
  const alive = () => { try { return !!chrome.runtime?.id; } catch (_) { return false; } };
  if (window.__cricketAdMuterAlive?.()) return;
  window.__cricketAdMuterAlive = alive;
  let dead = false;

  const DEFAULTS = { enabled: true, mode: 'mute', lowerVolume: 10, graceMs: 2000, overlay: true };
  const MANUAL_MAX_MS = 5 * 60 * 1000; // a "Mute now" ends by itself after this
  const BACK_MS = 2500;                // how long the badge says "Match is back"
  const RESUME_MAX_MS = 20000;         // give up waiting for the match to play after a break
  let settings = { ...DEFAULTS };

  let isAd = false;
  let adUntil = 0;
  let adName = '';
  let adSeconds = 0;
  let lastTick = -1;
  let lastEval = 0;
  let duck = null; // { video, saved, set } while the volume is lowered

  let heard = false;    // the user turned the sound on for this break
  let detected = false; // this break had a detected ad (so its end is "the match is back")
  let manualStart = 0;  // "Mute now": when it started,
  let manualUntil = 0;  //   and when it ends by itself (0 when off)
  let backUntil = 0;    // show "Match is back" on the video until
  let resume = null;    // after a break, until the match plays: { until, ct, paused (by the user) }

  let markers = [];         // this site's ad markers from rules.json
  let maxMarkerMs = 600000; // a marker showing longer than this is stuck
  let shown = null;         // { since, start, left, video } while a marker shows

  chrome.storage.sync.get(DEFAULTS, (s) => { settings = { ...DEFAULTS, ...s }; evaluate(true); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const modeChanged = 'mode' in changes || 'lowerVolume' in changes;
    for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue ?? DEFAULTS[k];
    if (modeChanged && isAd) {
      // Switch styles mid-break: undo the old one and apply the new one.
      applyDuck(false);
      sync();
    }
    evaluate(true);
  });

  function mainVideo() {
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    return bestArea > 10000 ? best : null;
  }

  // ---------- lower-volume mode ----------

  function applyDuck(on) {
    if (on) {
      const video = shown?.video || mainVideo(); // SonyLIV's pre-roll plays in its own <video>
      if (!video || (duck && duck.video === video)) return;
      const saved = video.volume;
      const set = +(saved * settings.lowerVolume / 100).toFixed(3);
      video.volume = set;
      duck = { video, saved, set };
    } else if (duck) {
      // Restore only if nobody (the user, the player) changed it meanwhile.
      if (Math.abs(duck.video.volume - duck.set) < 0.01) duck.video.volume = duck.saved;
      duck = null;
    }
  }

  // ---------- chime ----------

  function chime() {
    try {
      const ctx = new AudioContext();
      const t = ctx.currentTime;
      [[880, 0], [1318.5, 0.14]].forEach(([freq, delay]) => {
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t + delay);
        gain.gain.exponentialRampToValueAtTime(0.25, t + delay + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.45);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t + delay);
        osc.stop(t + delay + 0.5);
      });
      setTimeout(() => ctx.close(), 1200);
    } catch (_) { /* audio blocked */ }
  }

  // ---------- page markers (SonyLIV) ----------

  const isVisible = (el) => el.getClientRects().length > 0;
  const isPlaying = (v) => v instanceof HTMLMediaElement && !v.paused && !v.ended && v.readyState > 2;

  // "1:05", "-00:15" or "15" in the player's ad timer -> seconds left.
  function readTimer(selector) {
    for (const el of document.querySelectorAll(selector)) {
      const m = isVisible(el) && el.textContent.match(/(?:(\d+):)?(\d+)\s*$/);
      const left = m ? (+m[1] || 0) * 60 + +m[2] : 0;
      if (left > 0) return left;
    }
    return null;
  }

  // The first marker showing, as { el, left }, or null.
  function findMarker() {
    for (const m of markers) {
      try {
        for (const el of document.querySelectorAll(m.selector)) {
          if (!isVisible(el) || (m.playing && !isPlaying(el))) continue;
          return { el, left: m.timer ? readTimer(m.timer) : null };
        }
      } catch (_) { /* bad selector in a rules file */ }
    }
    return null;
  }

  // An ad is over, as far as the page shows: have it added to the history.
  function closeShownAd(now) {
    const seconds = Math.round((now - shown.start) / 1000);
    if (seconds >= 1 && now - shown.since <= maxMarkerMs) send({ type: 'LOG_AD', t: shown.start, seconds });
  }

  // While a marker shows, the ad runs at least until now (or as long as the
  // player's timer says); when it goes, the ad is over.
  function trackMarker(now) {
    if (!markers.length) return;
    const found = findMarker();
    if (!found) {
      if (shown) { closeShownAd(now); shown = null; adUntil = Math.min(adUntil, now); }
      return;
    }
    if (!shown) {
      shown = { since: now, start: now, left: null, video: null };
      adName = ''; adSeconds = 0;
    } else if (found.left && shown.left && found.left > shown.left + 1) {
      closeShownAd(now); // the timer went back up: the next ad in the break
      shown.start = now; adSeconds = 0;
    }
    if (now - shown.since > maxMarkerMs) return; // stuck on: stop trusting it
    shown.left = found.left;
    shown.video = found.el instanceof HTMLVideoElement ? found.el : null;
    if (found.left) adSeconds = Math.max(adSeconds, found.left);
    adUntil = Math.max(adUntil, now + (found.left || 0) * 1000);
  }

  // The player adds and removes markers on its own ad events. React straight
  // away rather than on the next tick, so the start of an ad isn't heard.
  const observer = new MutationObserver(() => {
    if (!!findMarker() !== !!shown) evaluate(true);
  });

  chrome.runtime.sendMessage({ type: 'PAGE_RULES' }, (r) => {
    void chrome.runtime.lastError;
    if (!r?.markers?.length) return; // a site detected from its requests
    markers = r.markers;
    maxMarkerMs = r.maxMarkerSeconds * 1000;
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    evaluate(true);
  });

  // ---------- badge on the video ----------
  // A pill over the top of the player during a break, with the sound button.
  // It lives in its own shadow root so the page's styles can't reach it, and
  // moves into the fullscreen element when there is one (nothing else shows).

  // A dead copy's badge can be left behind (say its tab was in the background
  // when the extension was reloaded); the copy that replaces it clears it.
  for (const old of document.querySelectorAll('[data-cricket-ad-muter]')) old.remove();

  const pill = (() => {
    const host = document.createElement('div');
    host.dataset.cricketAdMuter = '';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;transform:translateX(-50%);pointer-events:none';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      .pill { display: inline-flex; align-items: center; gap: .6em; padding: .45em .45em .45em .95em;
        border-radius: 999px; background: rgba(12, 14, 20, .88); color: #fff; pointer-events: auto;
        font: 600 1em/1.2 system-ui, -apple-system, "Segoe UI", sans-serif; white-space: nowrap;
        box-shadow: 0 6px 20px rgba(0, 0, 0, .35); animation: pop .2s ease-out; }
      /* No backdrop-filter: blurring the video under the badge costs the GPU every frame. */
      .pill[data-state="back"] { background: rgba(24, 140, 84, .92); padding-right: .95em; }
      .pill[data-state="heard"] .icon { opacity: .9; }
      .text { font-variant-numeric: tabular-nums; }
      button { font: inherit; font-size: .9em; font-weight: 700; color: #11131a; background: #fff; border: 0;
        border-radius: 999px; padding: .4em .9em; cursor: pointer; }
      button:hover { background: #e4e7ef; }
      button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
      button[hidden] { display: none; }
      @keyframes pop { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
      @media (prefers-reduced-motion: reduce) { .pill { animation: none; } }
    </style><div class="pill" role="status"><span class="icon" aria-hidden="true"></span><span class="text"></span><button type="button"></button></div>`;
    const el = root.querySelector('.pill');
    // Keep clicks on the badge away from the player (which would pause, etc).
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown']) {
      el.addEventListener(type, (e) => e.stopPropagation());
    }
    const btn = root.querySelector('button');
    btn.addEventListener('click', () => toggleSound());
    return { host, el, icon: root.querySelector('.icon'), text: root.querySelector('.text'), btn, key: '' };
  })();

  // [state, icon, text, button label] for the badge right now, or null.
  function pillContent(now) {
    if (!settings.overlay) return null;
    if (!isAd) {
      if (now < backUntil) return ['back', '✓', 'Match is back', ''];
      if (resume && !resume.paused) return ['resuming', '⏳', 'Match coming back…', ''];
      return null;
    }
    const detectedOn = now < adUntil + settings.graceMs;
    if (!detectedOn) {
      return settings.mode === 'lower' ? ['manual', '🔉', 'Turned down by you', 'Full volume'] : ['manual', '🔇', 'Muted by you', 'Unmute'];
    }
    const left = !(shown && !shown.left) ? Math.ceil((adUntil - now) / 1000) : 0;
    const t = left > 0 ? ` · ${left}s` : '';
    if (heard) return ['heard', '🔊', `Ad break, sound on${t}`, 'Mute'];
    if (settings.mode === 'lower') return ['lower', '🔉', `Ad turned down${t}`, 'Full volume'];
    return ['muted', '🔇', `Ad muted${t}`, 'Unmute'];
  }

  function renderPill(now = Date.now()) {
    const content = !dead && pillContent(now);
    const video = content && (shown?.video || mainVideo());
    if (!video) {
      if (pill.host.isConnected) pill.host.remove();
      pill.key = '';
      return;
    }
    const fs = document.fullscreenElement;
    const parent = fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement;
    if (pill.host.parentNode !== parent) parent.appendChild(pill.host);
    const r = video.getBoundingClientRect();
    pill.host.style.left = `${r.left + r.width / 2}px`;
    pill.host.style.top = `${r.top + Math.max(10, r.height * 0.05)}px`;
    pill.host.style.fontSize = `${Math.round(Math.min(18, Math.max(12, r.width / 72)))}px`;
    const key = content.join('|');
    if (key === pill.key) return;
    pill.key = key;
    const [state, icon, text, button] = content;
    pill.el.dataset.state = state;
    pill.icon.textContent = icon;
    pill.text.textContent = text;
    pill.btn.textContent = button;
    pill.btn.hidden = !button;
  }

  // ---------- state ----------

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg);
    } catch (_) {
      stop(); // extension was reloaded; this orphaned copy can't talk anymore
    }
  }

  // Tells the background what to do with the tab's sound, and sets the
  // video's volume in "lower volume" mode.
  function sync() {
    applyDuck(isAd && !heard && settings.mode === 'lower');
    send({ type: 'AD_STATE', isAd, heard, mode: settings.mode });
  }

  // ended: the break finished naturally (as opposed to pause / page leave /
  // the user's own mute), so the match is coming back.
  function setAd(state, ended = false) {
    if (state === isAd) return;
    isAd = state;
    lastTick = -1;
    if (!state) {
      heard = false;
      detected = false;
      if (ended) resume = { until: Date.now() + RESUME_MAX_MS, ct: null, paused: false };
    }
    sync();
  }

  // After a break the stream can take a few seconds to come back (SonyLIV
  // jumps to the live edge after its ads, with a black screen meanwhile).
  // Only once the match video is moving again does the badge say "Match is
  // back" and the user get the alert.
  function trackResume(now) {
    if (!resume) return;
    const v = mainVideo();
    const ct = v ? v.currentTime : null;
    const step = ct != null && resume.ct != null ? ct - resume.ct : 0;
    if (v && !v.paused && !v.seeking && v.readyState >= 3 && step > 0.05 && step < 3) {
      resume = null;
      backUntil = now + BACK_MS;
      // visible: the match is on screen, so the user needs no alert.
      send({ type: 'MATCH_BACK', visible: document.visibilityState === 'visible' });
    } else if (now > resume.until) {
      resume = null; // didn't come back by itself; nothing to announce
    } else {
      resume.ct = ct;
      // Paused with a picture loaded is the user's own pause: say nothing. A
      // reloading stream is paused with nothing loaded: that's "coming back".
      resume.paused = !v || (v.paused && v.readyState >= 3);
    }
  }

  // "Mute now" is over: log it, so missed ads show up in reports.
  function endManual(now) {
    if (!manualUntil) return;
    const seconds = Math.round((now - manualStart) / 1000);
    if (seconds >= 1) send({ type: 'LOG_AD', t: manualStart, seconds, manual: true });
    manualUntil = 0;
  }

  // The sound button. During a break: hear the rest of it, or mute it again
  // (a break, not just the current ad, so the next ad doesn't cut back in).
  // Otherwise: mute now, until pressed again, for an ad that wasn't caught.
  function toggleSound() {
    if (!settings.enabled) return;
    const now = Date.now();
    if (!isAd) {
      manualStart = now;
      manualUntil = now + MANUAL_MAX_MS;
    } else if (manualUntil && now >= adUntil + settings.graceMs) {
      endManual(now); // only "Mute now" is running: end it
    } else {
      heard = !heard;
      if (heard) endManual(now);
      sync();
    }
    evaluate(true);
  }

  function evaluate(force = false) {
    if (dead) return;
    if (!alive()) { stop(); return; } // the extension was reloaded or removed
    const now = Date.now();
    if (!force && now - lastEval < 200) return;
    lastEval = now;

    if (!settings.enabled) {
      adUntil = 0; shown = null; manualUntil = 0; resume = null;
      setAd(false);
      renderPill(now);
      return;
    }
    trackMarker(now);
    if (manualUntil && now >= manualUntil) endManual(now);

    const detectedOn = now < adUntil + settings.graceMs;
    if (detectedOn) detected = true;
    if (detectedOn || manualUntil) {
      setAd(true);
      if (settings.mode === 'lower' && !heard) applyDuck(true); // video element may have been swapped
      const left = detectedOn ? Math.max(0, Math.ceil((adUntil - now) / 1000)) : 0;
      if (left !== lastTick) {
        lastTick = left;
        send({ type: 'AD_TICK', secondsLeft: left });
      }
    } else {
      setAd(false, detected);
      trackResume(now);
    }
    renderPill(now);
  }

  // ---------- drivers ----------
  // timeupdate fires ~4x/s while video plays and keeps firing in background
  // tabs, where timers get throttled, so it's the main heartbeat.
  const onTick = () => evaluate();
  document.addEventListener('timeupdate', onTick, true);
  const interval = setInterval(onTick, 500);
  // SonyLIV's pre-roll is marked by its own video starting to play.
  const onPlaying = () => { if (markers.length) evaluate(true); };
  document.addEventListener('playing', onPlaying, true);
  // Keep the badge on the player as it moves, resizes or goes fullscreen.
  const onLayout = () => { if (pill.key && !dead) renderPill(); };
  document.addEventListener('fullscreenchange', onLayout);
  window.addEventListener('resize', onLayout);
  window.addEventListener('scroll', onLayout, { capture: true, passive: true });
  const onHide = () => { resume = null; if (isAd) { adUntil = 0; shown = null; manualUntil = 0; setAd(false); } };
  window.addEventListener('pagehide', onHide);

  function stop() {
    dead = true;
    document.removeEventListener('timeupdate', onTick, true);
    document.removeEventListener('playing', onPlaying, true);
    document.removeEventListener('fullscreenchange', onLayout);
    window.removeEventListener('resize', onLayout);
    window.removeEventListener('scroll', onLayout, { capture: true });
    clearInterval(interval);
    observer.disconnect();
    window.removeEventListener('pagehide', onHide);
    pill.host.remove();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    switch (msg?.type) {
      case 'NET_AD':
        adUntil = msg.until;
        adName = msg.name || '';
        adSeconds = msg.seconds;
        if (heard) sync(); // the worker may have muted for this ad before hearing about it
        evaluate(true);
        break;
      case 'CHIME':
        chime();
        break;
      case 'TOGGLE_SOUND':
        toggleSound();
        reply({ isAd, heard });
        break;
      case 'STATUS': {
        evaluate(true);
        const active = Date.now() < adUntil + settings.graceMs;
        const timed = active && !(shown && !shown.left); // a marker without a timer gives no end time
        reply({
          isAd, heard, manual: isAd && !active, resuming: !isAd && !!resume && !resume.paused,
          hasVideo: !!mainVideo(), enabled: settings.enabled, mode: settings.mode,
          adName: active ? adName : null, adEndsAt: timed ? adUntil : null, adSeconds: timed ? adSeconds : null,
        });
        break;
      }
    }
  });
})();
