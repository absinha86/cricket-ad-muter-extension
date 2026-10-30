# Chrome Web Store listing: copy and form answers

Paste these into the Developer Dashboard. The same text works for Microsoft Edge Add-ons.

---

## Store listing tab

**Name**
Cricket Ad Muter

**Summary** (max 132 characters)
Mutes ad breaks during live cricket on JioHotstar and SonyLIV, and brings the sound back the moment the match resumes.

**Category**
Entertainment

**Language**
English

**Description**

```
Tired of loud ads between overs? Cricket Ad Muter quietly handles every ad break during live cricket on JioHotstar and SonyLIV, then brings the sound back the moment play resumes. No clicking, no reaching for the volume.

HOW IT WORKS
• Detects each ad as it starts and knows how long it runs
• Mutes the tab for exactly that long, including back-to-back ads
• Sound comes back automatically when the match returns

FEATURES
• A badge on the video while an ad plays ("Ad muted · 23s"), even in fullscreen
• You're in control: unmute a break you want to hear, or mute an ad that slipped through, from the badge, the popup, or Alt+Shift+M
• Mute or lower volume: silence ads completely, or just turn them down (0–50%)
• "The match is back" alert: step away during the break and get a notification (plus an optional chime) when play resumes
• Live countdown on the toolbar icon while an ad plays
• Ad breaks skipped this match, today, or this week, and how much ad audio you avoided
• Pick which sites it works on: JioHotstar, SonyLIV, or both
• One-tap pause, or press Alt+Shift+H
• Light and dark mode

PRIVATE BY DESIGN
• No accounts, no analytics, no tracking
• Everything stays in your browser
• Only runs on JioHotstar and SonyLIV
• Doesn't block or skip ads; it just controls your own volume

Found an ad that slipped through? Use "Report a problem" in the popup's settings and it'll be fixed fast. Detection updates reach you automatically without waiting for a new version.

Cricket Ad Muter is an independent project and is not affiliated with, endorsed by, or sponsored by JioStar, JioHotstar, Sony Pictures Networks India or SonyLIV.
```

**Small promo tile** (440×280): `store/promo-small-440x280.png`

**Screenshots** (1280×800): upload in this order. They show the 1.1 popup with made-up advertiser names; the player in the second one is an illustration, not broadcast footage.
1. `store/1-ad-muted.png`: an ad muted on SonyLIV, with the countdown and "Unmute this break"
2. `store/2-badge-on-video.png`: the badge on the video
3. `store/3-your-call.png`: JioHotstar, this match's ad breaks and "Mute now"

**Icon**: `icons/icon-128.png`

**Homepage URL**: `https://github.com/absinha86/cricket-ad-muter-support`
**Support URL**: `https://github.com/absinha86/cricket-ad-muter-support/issues`

---

## Privacy practices tab

**Single purpose**
Automatically mutes or lowers the volume of the JioHotstar or SonyLIV tab during ad breaks in live streams, and restores the sound when the ad break ends.

**Permission justifications**

| Permission | Justification |
|---|---|
| `webRequest` | Observes (does not block or modify) requests on the supported sites to recognise JioHotstar's request to its own ad-impression endpoint, which marks when an ad starts and how long it lasts. Limited to JioHotstar and SonyLIV domains by the host permissions; on SonyLIV ads are recognised on the page instead. |
| Optional host permissions (`*.hotstar.com`, `*.jiohotstar.com`, `*.sonyliv.com`) | Requested at runtime from the welcome page or popup, per site, not at install. On JioHotstar, needed to observe the ad-start request above. On both sites, needed to run the content script that times the ad break (on SonyLIV it does this by watching the video player's own "AD" marker) and lowers the video volume in "lower volume" mode. The extension does nothing on any other site and has no access at all until the user grants it. |
| `activeTab` | When the user opens the popup, lets it read the current tab's URL to tell whether it's JioHotstar or SonyLIV, so it can show that site's status and offer access for that site. No access to any other tab, and nothing is read from the page. |
| `storage` | Saves the user's settings and a local list of recently muted ads shown in the popup. Never transmitted. |
| `scripting` | Registers the extension's own bundled content script for the sites the user grants access to (it can't be declared in the manifest because site access is optional), and injects it into JioHotstar or SonyLIV tabs that were already open so no page reload is needed. |
| `notifications` | Shows the optional "The match is back" notification when an ad break ends. |
| `alarms` | Schedules a check every 6 hours for an updated `rules.json` (ad-detection patterns, data only) from the project's public GitHub repository. |

**Are you using remote code?**
**No.** The extension downloads a JSON data file (`rules.json`) with URL patterns and regular expressions used to recognise ad requests. It contains no JavaScript and is never executed; all code is bundled in the package.

**Data usage**: tick **none** of the data-collection categories. The extension does not collect or transmit user data.
Tick all three certifications:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL**
`https://github.com/absinha86/cricket-ad-muter-support/blob/main/PRIVACY.md`

---

## Distribution tab

- Visibility: **Public**
- Regions: all regions, or India only if you prefer (JioHotstar is India-focused)
- Pricing: Free
