# CookieMonster system CLI

Branded Windows and macOS installers include the same `opencode` binary used by the desktop sidecar. WPP credentials and browser profile data are never copied into the command installation.

## Windows

Run the CookieMonster `.exe`. The per-user NSIS installer validates `resources\cli\opencode.exe`, then owns one exact `resources\cli` entry in the current user's `PATH`. Open a new terminal after installation. Upgrade replaces the executable without duplicating the entry; uninstall removes only CookieMonster's normalized entry.

The app's **Install CLI** action is a repair operation for a packaged branded install. It does not replace the installer.

## macOS

Open Design users must run the CookieMonster `.pkg`. It installs `/Applications/CookieMonster.app` and creates `/usr/local/bin/opencode` only when that destination is absent or already points to CookieMonster's current or legacy bundled CLI. It refuses regular files and links owned by another installation. The `.dmg` is app-only.

For full removal, run `sudo packages/desktop/scripts/uninstall-macos-cli.sh` from a trusted checkout or support bundle, then remove `/Applications/CookieMonster.app`. The cleanup script refuses paths CookieMonster does not own.

After either installer finishes, launch CookieMonster and complete WPP SSO. CookieMonster must remain running while `opencode` or Open Design sends requests through a `CM_*` model.

## Validation

The manual release workflow builds on each native OS. Before uploading artifacts it installs and uninstalls the Windows package, installs the macOS PKG twice, runs the installed command, and verifies registration ownership and cleanup. Unsigned internal builds still produce SmartScreen and Gatekeeper warnings.
