# CookieMonster macOS installation

macOS is the supported CookieMonster release target. Branded builds ship an app-only DMG and ZIP, not a system-wide PKG. The desktop app retains its bundled internal sidecar but does not install a public `opencode` command or provide Open Design command discovery. Legacy Windows public CLI installation remains unchanged in source.

## Per-user installation

Open CookieMonster in the DMG and choose **Install for My User**. The app copies itself to `~/Applications/CookieMonster.app`, opens the installed copy, and quits the disk-image copy. No administrator authorization, system-wide symlink, or shell-profile change is required. Eject the disk image after the installed app opens, then complete WPP SSO.

If macOS uses App Translocation, the app asks for manual installation rather than guessing the original bundle location. In Finder, open your home folder, create `Applications` if needed, and copy `CookieMonster.app` there. Open that copy and eject the image. ZIP downloads also use this manual copy procedure.

To update, quit the installed CookieMonster before opening the new DMG app and choosing **Install for My User**. The installer copies the entire new bundle into a `CookieMonster Install-` staging folder under `~/Applications` before moving the existing app into a unique `CookieMonster Backup-` folder there. It then publishes the complete new bundle at `~/Applications/CookieMonster.app`, without merging files from the previous release. Only the immediately previous app is retained after a successful replacement with permission restoration complete. Older completed installer-owned backups are then removed, with no timer or expiry. A failed copy leaves the old installation untouched and can leave a partial staging bundle; inspect it before removing it. If publishing fails after the old app was moved, the installer attempts to restore it without overwriting a concurrent destination, retaining the backup if restoration fails. Files and symlink destinations are rejected. Application settings and WPP browser data remain separate from the app bundle.

Completed backups have a `.cookiemonster-backup` ownership record outside the app bundle, tied to the container and app filesystem identities. Cleanup checks that record and the exact container contents before deleting an older app, and never recursively deletes its container. Unmarked failed-install recovery copies, partial staging folders, symlinks, changed candidates and unrelated entries are left alone. Failed staging, publication or recovery does not prune any backups. Cleanup is best-effort: unreadable or changed records and deletion failures can leave extra or partially removed older backups without failing a successfully published install. Inspect retained folders in Finder if manual cleanup is needed. A later successful replacement retries still-valid completed backups. Opening the app happens after this policy runs; a launch failure does not undo successful replacement or pruning.

Read-only bundle roots temporarily gain owner-write permission for macOS directory moves. The installer restores their original mode through an open directory handle. If mode restoration or handle cleanup fails after a move, installation reports failure and attempts to recover a moved previous app. A complete new app may already occupy the install location; it is retained rather than overwritten. A failed mode restoration can leave the affected bundle root owner-writable. Inspect the install and recovery folders before retrying.

Per-user installation does not bypass Gatekeeper or device-management policy. Follow macOS prompts and contact IT if the app is blocked.

## Signed builds

From `packages/desktop` on a Mac with a Developer ID Application identity and notarization credentials configured for electron-builder:

```sh
CM_BRAND=1 CM_UNSIGNED=0 OPENCODE_CHANNEL=prod bun run build
CM_BRAND=1 CM_UNSIGNED=0 OPENCODE_CHANNEL=prod bun run package:mac -- --publish never
```

To produce only the DMG, use `CM_BRAND=1 CM_UNSIGNED=0 OPENCODE_CHANNEL=prod bun run package -- --mac dmg --publish never` after building. Signing, hardened runtime, and notarization remain enabled when `CM_UNSIGNED` is not `1`. Credentials must stay in the local signing environment or keychain, never in the repository.

## Removal and legacy installs

For a new per-user installation, quit CookieMonster and remove `~/Applications/CookieMonster.app`. This leaves settings and WPP sign-in data intact and requires no privileged cleanup.

An older PKG installation can still own `/Applications/CookieMonster.app` and `/usr/local/bin/opencode`. The new app neither updates nor removes those files. IT can run `sudo packages/desktop/scripts/uninstall-macos-cli.sh` from a trusted checkout before removing the old system app. The script requires the relative layout of `resources/macos/pkg-scripts/cli-link.sh`; it removes only exact CookieMonster symlink targets, including dangling links, and leaves unrelated commands untouched. IT can forget the old package receipt according to its policy. Legacy cleanup is not required to run the new per-user app.

## Validation and releases

Run `bun test electron-builder.config.test.ts src/main/macos-user-install.test.ts src/main/system-cli.test.ts --timeout 20000` from `packages/desktop` for packaging, user-install, and public CLI capability checks.

The manual macOS workflow uses `CM_UNSIGNED=1`. It validates copying the DMG app into a disposable directory under the user's home, private executable availability, repeated replacement with exactly one immediately previous backup and stale-file removal, restoration of read-only bundle-root modes and pruning of older read-only backups, reinstallation after removal, and cleanup without system-wide installation. It uploads only the DMG. The default `publish=false` does not publish a release; `publish=true` explicitly publishes after validation.

These checks do not prove Gatekeeper acceptance, Finder launch, or a WPP-backed request. Before distributing a signed build, test on the intended standard-user Mac: install into `~/Applications`, launch after ejecting the DMG, complete SSO, send a prompt, restart, and confirm no administrator installation prompt or public CLI dependency. Verify the signed app and notarization with macOS tooling. Native checks cannot run on Linux or Windows development hosts.
