# CookieMonster system CLI installer plan

## Status

Planning document only. None of this behavior is implemented yet.

## Goal

Install CookieMonster and a terminal-visible `opencode` command in one installer flow on Windows and macOS. Open Design must not require a second software installation after the temporary WPP administrator password expires.

WPP SSO remains a separate, unprivileged first-launch step. The installer must not store WPP cookies, passwords, or tokens.

## Scope

This plan covers:

- CookieMonster-branded Windows NSIS installers.
- CookieMonster-branded macOS PKG installers.
- CLI installation, command discovery, upgrades, repair, and removal.
- Packaging configuration, CI artifacts, and native installer smoke tests.
- The boundary between privileged software installation and later WPP SSO.

This plan does not change:

- Upstream OpenCode `beta` or `prod` desktop installers.
- Linux packaging.
- The WPP bridge protocol or model roster.
- The CLI executable itself.

## Current state

- `packages/desktop/scripts/prebuild.ts` downloads the platform CLI when `OPENCODE_CHANNEL=dev`.
- `packages/desktop/scripts/utils.ts` writes `resources/opencode-cli` or `resources/opencode-cli.exe`.
- `packages/desktop/electron-builder.config.ts` includes that binary as an unpacked resource for `dev`.
- CookieMonster CI sets `OPENCODE_CHANNEL=dev`, `CM_BRAND=1`, and `CM_UNSIGNED=1`.
- `packages/desktop/src/main/background-cli.ts` stages a private copy under Electron `userData`.
- That private copy is not on `PATH`, so Open Design cannot discover it as `opencode`.
- Windows ships an NSIS `.exe`.
- macOS ships a drag-and-drop `.dmg`.
- Preload exposes an `install-cli` request, but main does not register the matching IPC handler.

## Required behavior

After installation:

- `opencode --version` works in a newly opened terminal.
- The command resolves to the CLI bundled with the installed CookieMonster release.
- CookieMonster continues to use its private sidecar path, independent of shell `PATH`.
- Upgrades replace the CLI without duplicating command registration.
- Uninstall removes only command registration owned by CookieMonster.
- Existing unrelated OpenCode installations are never deleted.
- CLI registration failure prevents the installer from reporting success.
- No WPP secrets are copied into the CLI installation.

CookieMonster must still be running when Open Design sends WPP-backed requests because the provider uses the local bridge at `127.0.0.1:8787`.

## Shared packaging

Keep `resources/opencode-cli` and `resources/opencode-cli.exe` for the desktop sidecar. Add an installer-facing copy named as the public command:

| Platform | Packaged path |
| --- | --- |
| Windows | `resources/cli/opencode.exe` |
| macOS | `Contents/Resources/cli/opencode` |

Both copies must come from the same downloaded artifact. Do not download the CLI twice.

Update `packages/desktop/scripts/utils.ts` and `packages/desktop/scripts/prebuild.ts` to:

- Produce both names for branded builds.
- Verify that they are byte-identical before platform signing.
- Preserve executable mode on macOS.
- Fail prebuild if either required output is missing.

Update `packages/desktop/electron-builder.config.ts` to include the public CLI only when `CM_BRAND=1`. Introduce one packaging-time `branded` boolean derived from `CM_BRAND`; do not use `OPENCODE_CHANNEL=dev` as a branding test because upstream development builds use that channel too.

Use narrow ownership rules:

- Windows owns only its exact user `PATH` entry for the installed `resources\cli` directory.
- macOS owns `/usr/local/bin/opencode` only when it is a symlink to a CookieMonster app CLI path.
- Neither installer may remove a regular file, another application's symlink, or an unrelated `PATH` entry.

## Windows implementation

### Installation layout

Keep the existing per-user NSIS installation:

- Application: the existing `$INSTDIR`.
- Public CLI: `$INSTDIR\resources\cli\opencode.exe`.
- User `PATH` entry: `$INSTDIR\resources\cli`.

Do not switch `nsis.perMachine` to `true` unless WPP deployment policy explicitly requires a machine-wide installation. A per-user app and `HKCU` `PATH` entry preserve the current update model and do not require machine-wide environment changes.

The NSIS installer must perform desktop and CLI installation in one run. CLI installation must not be deferred to first app launch.

### NSIS integration

Add `packages/desktop/resources/windows/cli-install.nsh`.

Set `nsis.include` to this file only for CookieMonster-branded builds. Implement Electron Builder's NSIS extension macros:

- `customInstall`
- `customUnInstall`

`customInstall` must:

1. Verify `$INSTDIR\resources\cli\opencode.exe` exists.
2. Execute `opencode.exe --version` and require exit code zero.
3. Read the current user `PATH` from `HKCU\Environment`.
4. Parse `PATH` as semicolon-delimited entries.
5. Compare entries case-insensitively after normalizing quotes and trailing separators.
6. Prepend `$INSTDIR\resources\cli` only when the exact normalized entry is absent.
7. Write the updated value as `REG_EXPAND_SZ`.
8. Broadcast `WM_SETTINGCHANGE` for `Environment`.
9. Abort installation with a clear message if validation or registry update fails.

Do not use substring matching. For example, `C:\CookieMonster-old\resources\cli` must not count as the current entry.

`customUnInstall` must:

1. Read the current user `PATH`.
2. Remove only the exact normalized `$INSTDIR\resources\cli` entry.
3. Preserve every unrelated entry and its order.
4. Delete the registry value only if it becomes empty.
5. Broadcast `WM_SETTINGCHANGE`.

Electron Builder removes the CLI binary with the rest of `$INSTDIR`; the custom uninstall hook owns only `PATH` cleanup.

### Existing OpenCode commands

Prepending CookieMonster's directory makes its compatible CLI win in new processes while CookieMonster is installed. Do not delete another `opencode.exe`.

If another installation has an identical command earlier in a process's inherited environment, diagnostics must report it. A newly opened terminal should use the updated user `PATH`.

After CookieMonster is uninstalled, removing its exact entry restores the previous command resolution.

### Upgrades

NSIS upgrades reuse `$INSTDIR`:

- Electron Builder replaces `resources\cli\opencode.exe`.
- `customInstall` sees the existing exact `PATH` entry and does not duplicate it.
- The command changes version with the app.
- The old app-owned executable disappears through normal installer replacement.

### Repair action

Restore the missing `install-cli` IPC handler as an optional repair path, not as the primary installation flow.

The handler may:

- Verify that the packaged public CLI exists.
- Restore the current user's exact `PATH` entry.
- Broadcast the environment change.
- Return the installed command path.

It must reject unpackaged or unbranded builds unless separate development behavior is explicitly designed.

### Windows tests

Add unit tests for pure `PATH` transformations:

- Empty `PATH`.
- Entry absent.
- Entry already present.
- Different casing.
- Quotes and trailing separator differences.
- Similar prefix that is not the same entry.
- Duplicate owned entries collapse to one on install and zero on uninstall.
- Uninstall preserves unrelated entries and order.

Extend `packages/desktop/electron-builder.config.test.ts` to assert:

- Branded Windows builds include `resources/cli/opencode.exe`.
- Branded Windows builds set `nsis.include`.
- Unbranded builds do not include the custom installer hook.
- Existing signing and unsigned behavior remains unchanged.

Add a Windows CI smoke test:

1. Save the runner user's original `PATH`.
2. Run the NSIS installer silently.
3. Start a new PowerShell process so it reloads the user environment.
4. Assert `Get-Command opencode` resolves inside CookieMonster's install directory.
5. Assert `opencode --version` exits successfully.
6. Run the uninstaller silently.
7. Start another PowerShell process.
8. Assert CookieMonster's exact `PATH` entry is gone.
9. Assert unrelated `PATH` entries are unchanged.

## macOS implementation

### Add a PKG installer

A DMG cannot reliably perform privileged command registration. Add a CookieMonster `.pkg` artifact and make it the supported installer for Open Design.

Configure the branded macOS build with:

- Electron Builder's `pkg` target.
- Install location `/Applications`.
- App path `/Applications/CookieMonster.app`.
- Relocation disabled.
- Installation outside `/Applications` disabled.
- Scripts directory `packages/desktop/resources/macos/pkg-scripts`.

The existing DMG may remain for one transition release, but it must be described as app-only because it does not satisfy the Open Design CLI prerequisite.

### PKG postinstall

The package contains:

`/Applications/CookieMonster.app/Contents/Resources/cli/opencode`

Add an executable `packages/desktop/resources/macos/pkg-scripts/postinstall` script. It must:

1. Use absolute paths and `set -eu`.
2. Verify the bundled CLI exists and is executable.
3. Run the bundled CLI with `--version` and require exit code zero.
4. Create `/usr/local/bin` with mode `0755` only when it does not exist.
5. Leave an existing `/usr/local/bin` directory's owner and mode unchanged.
6. Inspect `/usr/local/bin/opencode` before changing it.
7. Replace the link when it points to CookieMonster's current or known legacy bundled CLI path.
8. Create the new symlink atomically.
9. Fail with an actionable installer error when the destination is a regular file or a symlink owned by another installation.
10. Never edit `.zshrc`, `.zprofile`, `.bashrc`, or another user's home directory.

Using `/usr/local/bin` avoids guessing the logged-in user's home while the PKG script runs as root. Verify during macOS acceptance testing that WPP's supported terminal and Open Design environments include `/usr/local/bin`.

### Existing OpenCode commands

Do not silently overwrite an unrelated `/usr/local/bin/opencode`.

The installer should stop and tell the user to remove or relocate the existing command, then rerun the same PKG while temporary administrator access is still active. This is safer than replacing an unknown Homebrew, npm, or manual installation.

A user-level `~/.opencode/bin/opencode` may still take precedence depending on shell configuration. Add diagnostics for all discovered command paths and document `command -v -a opencode`. Do not edit shell profiles from the PKG.

### Upgrades

PKG upgrades reinstall the app at the fixed `/Applications/CookieMonster.app` path:

- App replacement updates the bundled CLI.
- The symlink target remains stable.
- `postinstall` validates and recreates the link idempotently.
- No shell profile or `PATH` mutation is required.

### Removal

macOS packages do not receive an automatic uninstall hook when a user drags an app to Trash.

Add `packages/desktop/scripts/uninstall-macos-cli.sh` for IT and support. It must remove `/usr/local/bin/opencode` only if the link points inside `/Applications/CookieMonster.app`. It must leave regular files and unrelated links untouched.

Document the supported full removal sequence:

1. Run the CLI cleanup script with administrator authorization.
2. Remove `/Applications/CookieMonster.app`.
3. Optionally forget the package receipt if IT policy requires it.

If the app is deleted without cleanup, the remaining symlink is dangling but contains no executable code. A later PKG installation repairs it.

### Launch and WPP SSO

Do not launch the app as root from `postinstall`.

The PKG conclusion page should tell the user to open CookieMonster and complete WPP SSO. CLI installation is complete at that point, so the temporary administrator credential is no longer needed.

CookieMonster must be running whenever Open Design uses the WPP-backed provider. First launch writes the provider configuration and starts the local bridge.

### macOS tests

Extend `packages/desktop/electron-builder.config.test.ts` to assert:

- Branded macOS builds include `pkg`.
- PKG install location is `/Applications`.
- PKG relocation is disabled.
- PKG scripts point to the checked-in scripts directory.
- Unbranded builds retain their existing targets and behavior.

Add shell-level tests for link ownership decisions:

- Missing destination.
- Existing CookieMonster-owned symlink.
- Known legacy CookieMonster symlink.
- Dangling CookieMonster-owned symlink.
- Symlink to another installation.
- Existing regular file.
- Missing bundled CLI.
- Non-executable bundled CLI.

Add a macOS CI smoke test:

1. Install the PKG with `sudo installer -pkg ... -target /`.
2. Assert `/Applications/CookieMonster.app` exists.
3. Assert `/usr/local/bin/opencode` resolves to the app's bundled CLI.
4. Assert `/usr/local/bin/opencode --version` exits successfully.
5. Install the same PKG again and assert the operation is idempotent.
6. Run the cleanup script.
7. Assert the symlink is removed without modifying unrelated files.

## Application integration

The system command and desktop sidecar serve different entry points but use the same CLI build:

- Keep `startBackgroundCli()` on `opencode-cli(.exe)` so desktop startup is independent of shell `PATH`.
- Keep WPP provider configuration in `proxy/providerConfig.mjs`.
- Continue writing CookieMonster provider configuration on app boot.
- Do not embed bridge credentials in the installed CLI or global config.
- Keep the bridge bound to loopback.

Add non-fatal startup diagnostics for:

- Bundled CLI version.
- Expected public command path.
- Whether registration is correct.
- Whether another `opencode` shadows CookieMonster.

A registration problem must not prevent CookieMonster from starting. It should be visible in diagnostics and repairable.

## CI and release

Update `.github/workflows/cookiemonster-desktop.yml` to:

- Build PKG on macOS, optionally retaining DMG for one transition release.
- Upload `.pkg` artifacts.
- Include `.pkg` in release assets.
- Run native Windows and macOS installation smoke tests before upload.
- Keep `CM_BRAND=1`, `CM_UNSIGNED=1`, and `OPENCODE_CHANNEL=dev`.
- Keep each installer on its native runner.

Update internal installation guidance:

- Windows users run the `.exe`.
- macOS Open Design users run the `.pkg`, not the `.dmg`.
- Both installers include the CLI.
- Windows users open a new terminal after installation.
- Users launch CookieMonster and complete WPP SSO before using Open Design.
- CookieMonster must remain running for WPP-backed requests.
- Unsigned builds still trigger SmartScreen or Gatekeeper warnings.

## Expected file changes

| File | Change |
| --- | --- |
| `packages/desktop/scripts/utils.ts` | Produce internal and public CLI resource names from one download |
| `packages/desktop/scripts/prebuild.ts` | Require both CLI outputs in branded builds |
| `packages/desktop/electron-builder.config.ts` | Gate public resources, NSIS include, and PKG settings behind `CM_BRAND` |
| `packages/desktop/resources/windows/cli-install.nsh` | Register and unregister the Windows command |
| `packages/desktop/resources/macos/pkg-scripts/postinstall` | Register `/usr/local/bin/opencode` |
| `packages/desktop/scripts/uninstall-macos-cli.sh` | Remove only the CookieMonster-owned symlink |
| `packages/desktop/src/main/system-cli.ts` | Diagnostics and optional repair logic |
| `packages/desktop/src/main/ipc.ts` | Restore the `install-cli` repair handler |
| `packages/desktop/electron-builder.config.test.ts` | Assert branded and upstream package separation |
| `packages/desktop/src/main/system-cli.test.ts` | Test path and ownership decisions |
| `.github/workflows/cookiemonster-desktop.yml` | Build, smoke-test, upload, and release new artifacts |
| `AGENTS.md` | Update packaging commands and artifact guidance |

## Implementation order

1. Refactor CLI preparation to emit both resource names.
2. Add branded packaging guards and configuration tests.
3. Implement and test Windows `PATH` registration.
4. Add NSIS install and uninstall hooks.
5. Implement and test macOS link ownership.
6. Add PKG postinstall and support cleanup scripts.
7. Restore or replace the stale repair action.
8. Add native installer smoke tests.
9. Update release artifact selection and documentation.
10. Complete manual Open Design acceptance testing.

## Manual acceptance

Run on clean Windows and macOS test machines:

1. Start the temporary WPP administrator window.
2. Run exactly one CookieMonster installer.
3. Confirm the installer reports success only after CLI registration succeeds.
4. Open a new terminal.
5. Run `opencode --version`.
6. Launch CookieMonster.
7. Complete WPP SSO.
8. Confirm `http://127.0.0.1:8787/bridge/health` reports healthy.
9. Confirm the CookieMonster provider and `CM_*` models appear.
10. Launch Open Design and verify it discovers `opencode`.
11. Run one Open Design request through a `CM_*` model.
12. Upgrade CookieMonster and verify the command version changes without another registration entry.
13. Uninstall and verify only CookieMonster-owned command registration is removed.

Repeat with:

- A previous CookieMonster version installed.
- An unrelated `opencode` already installed.
- An installation path containing spaces.
- A non-admin user who receives temporary elevation.
- Apple Silicon and Intel macOS artifacts when both architectures are distributed.
- Windows x64 and ARM64 artifacts when both architectures are distributed.

## Completion criteria

- Windows installs the app and discoverable CLI in one NSIS run.
- macOS installs the app and discoverable CLI in one PKG run.
- No first-launch elevation is needed.
- Upgrade and removal ownership tests pass.
- Native CI runs the installed CLI successfully.
- Open Design completes an end-to-end WPP-backed request on both platforms.
- Packaging is unchanged when `CM_BRAND` is absent.
