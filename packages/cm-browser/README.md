# CookieMonster browser

The desktop browser uses main-owned Electron `WebContentsView` tabs. Tabs belong to a chat session and retain their pages when switching tabs, switching sessions, or hiding the browser panel. Closing a tab respects its `beforeunload` handler. Pop-ups open as new tabs and preserve normal opener behavior.

## Using the browser

Open the browser panel, choose **New tab**, and enter an HTTP(S) address or search terms. Searches use `https://duck.com/?q=…`; bare domains and local development addresses navigate directly. Back, forward, reload, and stop work on the selected tab. URL, selected text, picked elements, and screenshots can be attached to the chat draft.

Within the browser, Control/Command+L selects the address bar, +T opens a tab, +W closes the tab (respecting unsaved-page confirmation), and +R reloads. Control+Tab switches forward and Control+Shift+Tab switches backward. Control/Command+Shift+T reopens the most recently closed tab. Recently closed tabs are also listed in History. New blank tabs focus the address bar.

The address bar suggests local history, bookmarks, and other tabs in the current task. Up/Down and Enter choose a suggestion; Escape dismisses it. Selecting an open tab switches to it without creating a duplicate. Pressing Enter without selecting a suggestion keeps normal URL/DuckDuckGo behaviour. Suggestions make no network requests.

Normal tabs and pop-ups keep the same Chromium user agent and actual engine version. Electron's fallback is also Chromium-based because its popup creation can ignore per-tab overrides (electron/electron#45897); this fallback is process-wide, while browser cookies and permissions remain partitioned.

Cookies use the separate persistent `persist:cm-browser` partition, shared by browser tabs but isolated from the app and WPP login. Pages have no Node integration or access to the desktop preload API. Restore tabs is enabled by default. Returning to a task restores its saved page URLs and selected tab, with agent access off and the vault locked. Recovery keeps up to 32 tabs per task, 20 recently closed tabs per task, and 50 recently saved tasks. It does not restore form values or back/forward stacks. Turning Restore tabs off deletes saved recovery data; open tabs and in-memory recently closed tabs remain available until the window closes. Camera and microphone permissions default to Block and can be configured per origin in Browser settings; other device permissions remain blocked.

Downloads use Electron's authenticated browser transfer. Browser settings can choose the destination folder and whether to show a native Save dialog (on by default). Automatic downloads reserve unique filenames without overwriting existing files; cancelled reservations are removed. An unavailable destination falls back to the Save dialog. Active downloads show progress and support pause, resume, and cancel through Electron DownloadItem. The most recent 200 finished download records persist across restarts, with filename search, timestamps, individual removal, and Show in folder when the completed file still exists. Clearing download history leaves the files on disk. Interrupted transfers are cancelled; retry from the page. Files are never opened automatically, and transfer resume across restarts is not implemented.

## Links, bookmarks, and site controls

Browser settings choose separate destinations for app web links and local development links. Web links default to the system browser; localhost (including `.localhost`), IPv4 loopback and IPv6 loopback default to CookieMonster. An active task is required for internal routing; otherwise the system browser is used. Links followed inside browser pages retain normal in-tab navigation and popup behaviour. Right-click links in the app or browser to explicitly open in CookieMonster or the default browser. Internal links open a fresh tab with agent access off.

Bookmarks are local to the private browser profile, with up to 2,000 entries. Add the current page from the address toolbar; manage, edit, delete, and pin favourites in Bookmarks. Pinned entries appear on the new-tab page. Import/export uses standard browser HTML bookmark files, parsed with `parse5` without executing scripts or fetching resources. Imports flatten folders, skip unsupported URLs, deduplicate by normalized URL, and preserve existing entries. Imports are limited to 5 MB and 2,000 supported entries. Export retains CookieMonster pin state in an optional HTML attribute. Clearing history does not remove bookmarks.

Site controls beside the address bar show whether the loaded page used HTTP or HTTPS, without treating HTTPS as a trust verdict. Chromium certificate failures remain blocked. Controls reuse the exact-origin camera/microphone settings, revoke current-tab agent access, and clear site data through Chromium's session API. Storage/cache clearing targets the selected origin; Chromium removes cookies for the registrable parent domain, which can sign out sibling subdomains. The native confirmation states this scope. Matching pages reload, and app/WPP sessions, bookmarks, history, passwords and permission rules remain separate.

## Browser menu and saved logins

The browser menu provides Chromium find-in-page (Control/Command+F), native printing (Control/Command+P), zoom, a 390×844 mobile preview, screenshot-to-chat, downloads, history, imports, and browser data settings. Mobile preview retains the real Chromium user agent. History retains up to 2,000 recent visits across browser sessions, including repeat visits, with title/URL search, dates, individual deletion, and opening a visit in a new tab. Existing history rows receive stable IDs without inventing past visits. Recording can be disabled in Browser settings. The default search engine remains DuckDuckGo.

Password storage uses Node's AES-256-GCM implementation for an authenticated vault containing passwords, websites, usernames, and credential IDs. A fresh random key is protected with Electron `safeStorage` (Windows DPAPI, macOS Keychain, or the Linux secret store) on every write. It fails closed when OS encryption is unavailable, Linux falls back to `basic_text`, authentication fails, or a remote-debugging port/pipe is enabled. The general renderer storage API cannot access the private browser store. Browser history remains local plaintext. The agent browser tools have no vault API, and snapshots exclude password-field values. See [Password security](password-security.md) for the threat model and outstanding assurance work.

**Passwords and autofill** can save a filled login before submission and fill a saved login on its exact origin, with agent access off. Saving and filling each require native confirmation naming the website and username. It never submits the form. Combined filling requires a single visible, unobscured password field and an unambiguous username field in the main document. Explicit username-only and password-only actions support multi-step logins on the same saved origin; username-only filling requires a uniquely identified username/email field. Each mode sends only its requested field to the page, over HTTPS (or HTTP loopback for development). Forms must use POST and same-origin submission destinations; form-less JavaScript logins are supported. Navigation, replaced fields, new-password fields, or concurrent agent access interrupt delivery. Iframe login forms, sign-ins that change origin between steps, automatic save prompts, address/payment autofill, and cross-device sync are not implemented.

**Import cookies and passwords** accepts user-selected Chrome/Edge/Firefox CSV password exports or an array of JSON cookie objects (`domain`, `name`, `value`, and optional `path`, `secure`, `httpOnly`, `hostOnly`, `sameSite`, `expirationDate`, `session`). CSV parsing reuses `csv-parse`. Password imports validate and encrypt the full batch before updating matching origin/username records. Insecure non-loopback password URLs are rejected. Cookie imports validate their shape before applying them through Chromium; a Chromium rejection can leave earlier cookies imported. Files are limited to 5 MB, with 2,000 password or 5,000 cookie rows. Exported CSV files contain plaintext passwords and should be removed by the user after import.

**Clear browsing data** provides a category checklist and one native confirmation. Last hour, 24 hours, 7 days, 30 days, and all-time ranges apply to history and download records. Clearing history also removes matching recently closed tabs from memory and saved recovery. Electron does not expose time ranges for cache/site storage, so cache, cookies/site data (signing out browser websites), and passwords require all time; both UI and main enforce this. Open tabs and downloaded files remain. App and WPP login storage are separate.

The vault starts locked and requires Windows Hello or Touch ID to unlock. It locks again after a fixed five-minute interval, on device lock/sleep, hiding/minimizing/closing an app window, renderer teardown, or **Lock now**. Locked UI state contains no saved account metadata. Unsupported authentication setups (including Linux) stay locked. Windows development/packaging builds compile a small C++/WinRT helper with Visual Studio C++ tools and the Windows SDK; it ships under `resources/vault-auth`. Run `bun scripts/build-vault-auth.ts` if launching electron-vite directly instead of the normal predev step. Reauthentication is an app-level gate and does not add Windows app-bound encryption.

Main-process changes take effect on the next launch. Renderer hot reload can show the menu earlier; no running app or server is restarted by this implementation.

Development builds no longer open port 9222 automatically. `CM_REMOTE_DEBUGGING=1` explicitly enables it in development; saved logins are unavailable in that mode. Packaged builds do not enable that port through this variable.

## Browser settings

Settings reuse Electron session permission handlers and DownloadItem APIs. Camera/microphone rules are exact-origin, main-frame only, HTTPS or loopback, with Block/Ask/Allow. Ask uses a native prompt per request, and OS permission requirements still apply. Changing a rule reloads matching open tabs and overrides page unload vetoes so existing capture stops. The native test uses fake media devices, never the physical camera or microphone.

Show full URL controls the unfocused address display; editing always exposes the complete URL. Include screenshots with selections adds a screenshot to the same captured chat draft as Add Selection. The global agent switch immediately revokes every tab grant; enabling it again does not restore old grants. Agent site access edits the actual main-enforced host allowlist; host rules include subdomains, and the existing tool approval remains separate.

The settings page links to the existing password manager, imports, browsing history, and data clearing. It deliberately does not advertise contact/payment autofill, agent history/upload permissions, WebMCP discovery, or unrestricted agent CDP access, which are not implemented. Controls requiring a newer main process are disabled during renderer hot reload until the next launch.

## Agent access

New tabs, including pop-ups, start with agent access disabled. The user must enable **Allow agent access** and accept the native confirmation for each tab. Revoking access interrupts further agent input and invalidates snapshots.

The existing five tools run in the OpenCode sidecar plugin and reach main through its parent port:

- `browser_read_state` without `tabID` lists opted-in tabs for the current session whose hosts are allowed, plus opted-in blank tabs.
- `browser_read_state` with `tabID` returns that tab's page and opaque element references.
- `browser_navigate`, `browser_click`, `browser_fill`, and `browser_press_key` require an explicit `tabID`.
- Click and fill references are bound to a specific tab and snapshot. Navigation and access revocation invalidate them.

Main enforces the host allowlist in `cm-browser-allowlist.json` in the CookieMonster state directory (`%APPDATA%/CookieMonster` on Windows). `CM_BROWSER_STATE_DIR` can supply an absolute state-directory override (the isolated smoke harness uses it). Defaults are `localhost`, `127.0.0.1`, and `teams.microsoft.com`. Regular user navigation can visit other HTTP(S) hosts; agent access cannot bypass the allowlist. The normal OpenCode tool approval also applies to agent mutations.

The renderer has only typed browser commands and fixed context operations, never an arbitrary JavaScript execution IPC endpoint. Main validates ownership against the app window's main frame.

## Verification

From `packages/cm-browser`: `bun test`, `bun typecheck`, and `bun run build`.

From `packages/desktop`: `bun test src/main/browser/`, `bun typecheck`, and `bun scripts/browser-smoke.ts`.

The native smoke script launches a separate Electron process with temporary user/session data and a loopback fixture server. It does not start the app or sidecar. It checks retained pages, session switching, navigation, pop-ups/opener behavior, cookie isolation, agent opt-in, real foreground/background input, stale references, failed-load recovery, context capture, overlay visibility, cancelled/confirmed tab closure, and download success/cancellation/interruption. Download tests assert Save dialog configuration, then choose a temporary destination programmatically; the native chooser itself still needs interactive verification.

From `packages/app`: `bun typecheck` and `bun test --conditions=solid --preload ./happydom.ts ./src/components/browser-panel`.
