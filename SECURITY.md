# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue: open the repository's **Security** tab and click **Report a vulnerability**. You'll get a reply within a few days.

Helpful to include: what an attacker could do, the steps to reproduce, and the extension version.

## Scope

- The extension's code in this repository.
- How it handles the online `rules.json` (detection patterns fetched from GitHub). The file is treated as untrusted data: it is never executed, it can only match requests and page elements on the sites the user has allowed, and its limits are capped.

Out of scope: JioHotstar, SonyLIV and Chrome themselves. Please report issues with those to their owners.

## Supported versions

Only the latest release gets security fixes.
