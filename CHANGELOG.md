# Changelog

## 1.1.0 (2026-10-30)

### New
- **SonyLIV support.** Live ad breaks and the opening pre-roll are muted the moment they start, using the player's own ad marker.
- **A badge on the video** while an ad plays ("Ad muted · 23s"), even in fullscreen, then "Match coming back…" and "Match is back".
- **Unmute this break** or **Mute now** (for an ad that slipped through) from the badge, the popup or Alt+Shift+M.
- Back-to-back ads are grouped into breaks, with totals for this match, today and the last 7 days.
- On first run you pick which sites to allow. The popup follows the site you're on, and settings are behind ⚙.

### Fixes
- "Match is back" and its alert wait until the match is actually playing again.
- The "match is back" notification no longer appears while the match is on screen.
- Reloading or updating the extension no longer leaves a stuck badge or a muted tab.
- Limits from the online rules file are capped, and problem reports no longer include exact times.

## 1.0.0 (2026-09-27)

First release: mutes or turns down ad breaks during live cricket on JioHotstar, with a "match is back" alert, a toolbar countdown and online detection rules.
