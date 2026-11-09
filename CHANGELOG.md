# Changelog

## 0.3.0

### Security
- **The API key no longer travels in the browser URL.** Sign-in now uses a one-time code with PKCE: the extension sends only a `code_challenge` to the panel, the browser comes back to the loopback callback with a short-lived code (2 minutes, single use), and the extension trades it for the key with `POST /integrations/vscode/token` plus the `code_verifier`, which never leaves VS Code. The key therefore never lands in the browser history. A panel without this flow still sends the key directly and keeps working.
- Keys created from VS Code now **expire**: the panel's consent screen lets the user pick 7, 30 (default) or 90 days, or no expiration at their own risk. When a key expires the extension already asks to sign in again (401 → "Sign in again").

## 0.2.1
- Source published at https://github.com/XeroHost/vscode-extension; repository, homepage and issue links point there.

## 0.2.0

### Added
- **Localization** in 10 languages (en, es, pt-br, fr, de, it, tr, zh-cn, ja, ko) using VS Code's own mechanisms: `package.nls.*.json` for commands, menus and settings, and `vscode.l10n.t()` with `l10n/bundle.l10n.*.json` for messages, quick picks, the status bar and the console. The sign-in callback page picks its language from the browser's `Accept-Language` (falling back to VS Code's display language).
- `npm run check:l10n` fails when a string used in the code, in `package.json` or in the callback page is missing from any language (it also runs before packaging).
- **Changes made outside VS Code are now picked up without reloading.**
  - `watch()` is implemented: the folders and files VS Code watches are polled and diffed (names, sizes, modification times), firing Created / Changed / Deleted. Open editors without unsaved edits reload by themselves.
  - New setting `xerohost.files.pollIntervalSeconds` (default 10, `0` = off, minimum effective 3).
  - Polling is deliberately light: at most 20 folders per cycle and 60 requests per minute, nothing while the window is unfocused, exponential backoff (up to 8x) on errors and `429`, never prompts for sign-in.
  - New command **XeroHost: Refresh** (Explorer title button, folder context menu, Command Palette): clears the caches, fires a change for the root and every listed folder and re-checks the watched folders immediately.
- Power states (Running, Offline...) and the status bar tooltip are translated.

### Changed
- Own saves, renames and deletes reset the folder's baseline so the next poll does not report them back as external changes.

## 0.1.0
- First release: server files as a workspace folder, console terminal, power actions in the status bar, archives, deep link and browser sign-in.
