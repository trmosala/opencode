# CookieMonster system CLI

macOS is the supported CookieMonster target. Branded installers include the same `opencode` binary used by the desktop sidecar. WPP credentials and browser profile data are never copied into the command installation. Legacy Windows implementation remains in source but is no longer built or validated by the CookieMonster release workflow.

## Installation

Open Design users must run the CookieMonster `.pkg`. It installs `/Applications/CookieMonster.app` and creates `/usr/local/bin/opencode` only when that destination is absent or already points to CookieMonster's current or legacy bundled CLI. It refuses regular files and links owned by another installation. The `.dmg` is app-only.

If registration conflicts with another command, relocate that command yourself and rerun the PKG while administrator authorization is available. The installer never edits shell profiles. In a new terminal, use `which -a opencode` to inspect all discovered commands and `opencode --version` to check the selected CLI. An earlier user-level installation can shadow `/usr/local/bin/opencode`. Startup diagnostics also report command discovery, registration, shadowing and the bundled sidecar version. The app's **Install CLI** action verifies registration on macOS; missing registration requires rerunning the PKG, not first-launch elevation.

After the installer finishes, launch CookieMonster and complete WPP SSO. CookieMonster must remain running while `opencode` or Open Design sends requests through a `CM_*` model. The installer does not launch the app as root or perform SSO.

## Removal

Run `sudo packages/desktop/scripts/uninstall-macos-cli.sh` from a trusted checkout, then remove `/Applications/CookieMonster.app`. A support bundle must preserve the relative layout of that script and `packages/desktop/resources/macos/pkg-scripts/cli-link.sh`. Cleanup removes only exact current or legacy CookieMonster symlink targets, including dangling links; unrelated links, regular files and directories remain untouched. Deleting only the app can leave a dangling command link, repaired by the next PKG installation. IT can optionally forget the package receipt according to its policy.

## Validation and releases

The manual release workflow now runs only on macOS. Its default `publish=false` builds and validates installers without creating or replacing a release. Set `publish=true` explicitly to publish after validation. Before artifact upload, it tests link ownership, installs the PKG twice, runs the installed command, checks fresh login-shell discovery and identical public/private CLI bytes, and verifies removal. It refuses a runner with a pre-existing app or command before arming cleanup. Unsigned internal builds still produce Gatekeeper warnings.

Local macOS ownership tests run with `packages/desktop/scripts/test-macos-cli.sh`; packaging configuration tests run with `bun test electron-builder.config.test.ts` from `packages/desktop`. The shell tests use disposable directories and synthetic executables. They cover missing and legacy targets, repeat installation, modes, failed executable validation, spaces, staging-name collision and exact removal ownership. Production link registration now uses an exclusively created temporary directory; it no longer reuses or cleans up a predictable PID-named file. Check-then-change link ownership is not a guarantee against concurrent privileged filesystem mutation.

Live Open Design discovery and an end-to-end WPP-backed request remain manual acceptance, as agreed for issue #4. Perform this after one PKG installation and WPP sign-in under the intended user's account, with `/usr/local/bin` available to Open Design. Native packaged install/reinstall/removal evidence is separate from local shell/configuration tests; do not treat a blocked CI job as a pass.
