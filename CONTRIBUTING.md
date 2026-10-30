# Contributing

Thanks for helping. Bug reports, detection fixes and code changes are all welcome.

## Where to report what

- **An ad played with sound, or the match stayed muted:** use **⚙ Settings → Report a problem** in the extension, or [open an issue in the support repo](https://github.com/absinha86/cricket-ad-muter-support/issues/new). That's where detection is tracked.
- **A bug in the code, or a feature idea:** [open an issue here](../../issues/new/choose).
- **A security problem:** report it privately, as described in [SECURITY.md](SECURITY.md).

## Running it locally

There's no build step: it's plain JavaScript, HTML and CSS.

1. Clone the repository.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the repository folder.
3. After changing a file, click the reload icon on the extension's card, then reload the match tab.

To debug the background worker, click **service worker** on the extension's card. The content script's logs are in the match tab's DevTools console.

## Fixing detection

Most breakages are a site changing its ad request or ad marker. These can be fixed in [`rules.json`](rules.json) without a new release; see [Fixing detection when a site changes](README.md#fixing-detection-when-a-site-changes). Remember to increase `version`.

## Pull requests

- Keep changes focused, and match the existing style: small functions, and comments that explain *why*.
- Test on a real match on the site you changed, and describe what you tested in the PR.
- No new permissions, remote code, analytics or tracking. The extension's privacy promise ([PRIVACY.md](PRIVACY.md)) has to stay true.
- New user-facing behaviour gets a line in [CHANGELOG.md](CHANGELOG.md).
