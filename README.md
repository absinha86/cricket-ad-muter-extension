# Cricket Ad Muter

A Chrome extension that mutes, or turns down, ad breaks during live cricket on **JioHotstar** and **SonyLIV**, and brings the sound back the moment the match resumes.

It doesn't block or skip ads. It only controls your own tab's sound.

## Features

- **Automatic.** Detects each ad as it starts and mutes the tab for exactly as long as the break lasts, including back-to-back ads.
- **A badge on the video** while an ad plays ("Ad muted · 23s"), even in fullscreen, with "Match coming back…" and then "Match is back" afterwards.
- **You stay in control.** Unmute a break you want to hear, or mute an ad that slipped through, from the badge, the popup, or **Alt+Shift+M**. **Alt+Shift+H** pauses the extension.
- **Mute or lower volume.** Silence ads completely, or turn them down to 0–50%.
- **"The match is back" alert** when you've stepped away during the break, with an optional chime.
- **History.** Ad breaks skipped this match, today and over 7 days, with a live countdown on the toolbar icon.
- **Light and dark mode.** The popup follows the site you're on.

## Install

**Chrome Web Store:** coming soon. Installing from the store is one click, and the extension then updates itself.

**From GitHub (manual install):**

1. Download the latest `cricket-ad-muter-<version>.zip` from [Releases](../../releases), or the whole repository with **Code → Download ZIP**.
2. Unzip it.
3. Open `chrome://extensions` and turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the unzipped folder (the one containing `manifest.json`).

A manual install doesn't update itself. To update, download the new version and click the reload icon on the extension's card in `chrome://extensions`. Fixes to ad detection still arrive automatically through [`rules.json`](#detection-rules).

On first run, a welcome page asks which sites to allow. You can add the other site later from the popup's ⚙ Settings.

## Privacy

Nothing is collected or sent anywhere. There are no accounts, analytics or trackers. Your settings and the list of muted ads stay in your browser. The full policy is in [PRIVACY.md](PRIVACY.md).

The only request the extension makes on its own is to download `rules.json` (detection patterns, data only) from GitHub about every 6 hours. See [Detection rules](#detection-rules).

## Permissions

| Permission | Why |
|---|---|
| Site access to `hotstar.com`, `jiohotstar.com`, `sonyliv.com` | Optional, asked per site after install. Needed to notice when an ad starts on that site. No access to any other site. |
| `activeTab` | Lets the popup tell whether the current tab is JioHotstar or SonyLIV. |
| `webRequest` | To see (never block or change) JioHotstar's ad-start request. |
| `scripting` | To load the extension's own script on the sites you allow. |
| `storage` | Settings and the local list of muted ads. |
| `notifications` | The optional "match is back" alert. |
| `alarms` | Checks for updated detection rules every few hours. |

## How it works

Both sites stitch ads into the live video itself, so the extension needs a signal for each ad's start.

**JioHotstar.** Nothing on the page marks an ad, but as each ad starts the page sends a tracking request to JioHotstar's own servers:

```
bifrost-api.hotstar.com/v1/events/track/ct_impression?adName=…_ENG_20&…
```

The ad name carries its length (`_20` = 20 s). `background.js` sees that request (observe-only), mutes the tab, and tells the page how long the ad runs.

**SonyLIV.** Its player marks stitched ads in the page itself. It adds the class `dai-ad-playing` to `.spn-player-wrapper` while each ad plays, and shows an "AD" label with the seconds left (`.ad-label-timer`). The pre-roll you get when you open a stream plays in a separate `<video title="Advertisement">`. `content.js` watches for these with a `MutationObserver`, so it mutes the moment an ad starts.

In both cases `content.js` keeps the break "on" until the last ad ends plus a short gap (2 s by default, so back-to-back ads stay muted), then the tab is unmuted. The extension only ever unmutes a tab it muted itself. "Match is back" (and the optional alert) waits until the match video is actually playing again.

## Detection rules

The detection patterns live in [`rules.json`](rules.json): request patterns for JioHotstar (`adPings`) and page markers for SonyLIV (`adMarkers`). The copy bundled with the extension is used until a newer `version` is published at:

```
https://raw.githubusercontent.com/absinha86/cricket-ad-muter-support/main/rules.json
```

That URL is built from `homepage_url` in `manifest.json`. The file is data only: regular expressions and CSS selectors, never code. It can only match requests and elements on the sites you've allowed, and the extension caps how long any rule can keep a tab muted.

### Fixing detection when a site changes

Edit `rules.json`. **Increase `version`**, because clients only switch to a file with a higher version than they already have. A newer file replaces the bundled one completely, so keep both sites' entries.

- **JioHotstar** (ads play with sound). In DevTools → **Network**, find the request that fires as each ad starts, then update:
  - `adPings[].host` / `path`: regexes for that request. The host must stay on `hotstar.com` / `jiohotstar.com`.
  - `nameParams`: the query parameter holding the ad name.
  - `durationPatterns`: regexes that pull the length out of the name.
- **SonyLIV** (ads play with sound, or the match stays muted). In DevTools → **Elements**, see what changes on the player while an ad plays, then update `adMarkers`:
  - `selector`: matches only while an ad plays.
  - `playing: true`: the element is a `<video>` that must be playing.
  - `timer`: the element showing the seconds left.

If detection needs a request to a domain outside those sites, add it to the site's `hosts` in `sites.js` and to `optional_host_permissions` in `manifest.json`.

## Reporting a problem

Use **⚙ Settings → Report a problem** in the popup. It opens a pre-filled GitHub issue with the extension, rules and Chrome versions, your mode setting, and the last few ads detected, and you review it before anything is posted. Or [open an issue](https://github.com/absinha86/cricket-ad-muter-support/issues) directly.

## Development

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (MV3) |
| `sites.js` | The supported sites, shared by the worker and the pages |
| `background.js` | Request-based detection, mute/unmute, notifications, rule updates |
| `content.js` | Break timing, SonyLIV's page markers, the badge on the video, lower-volume mode |
| `popup.*` | Toolbar popup: status, history and settings |
| `welcome.*` | First-run page that asks for site access |
| `rules.json` | Detection patterns (bundled, and updated from GitHub) |
| `icons/` | Icons, generated from `store/icon-source.png` by `node tools/make-icons.js` (needs ImageMagick) |
| `store/` | Store listing copy and screenshots (not part of the extension) |
| `tools/package.ps1` | Builds the store zip in `dist/` with only the files the extension needs |

To build the zip: `powershell -ExecutionPolicy Bypass -File tools\package.ps1`. This writes `dist\cricket-ad-muter-<version>.zip`, the file for both the Chrome Web Store and a GitHub release.

To publish a release: bump `version` in `manifest.json`, build the zip, then on GitHub go to **Releases → Draft a new release**, create a tag like `v1.1.0`, and attach the zip.

## License

[MIT](LICENSE)

---

Not affiliated with, endorsed by, or sponsored by JioStar, JioHotstar, Sony Pictures Networks India or SonyLIV. All trademarks belong to their owners.
