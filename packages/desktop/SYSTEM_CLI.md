# CookieMonster macOS installation

macOS is the supported CookieMonster release target. Branded builds ship an app-only DMG and ZIP, not a system-wide PKG. The desktop app retains its bundled internal sidecar but does not install a public `opencode` command or provide Open Design command discovery. Legacy Windows public CLI installation remains unchanged in source.

## Per-user installation

Open CookieMonster in the DMG and choose **Install for My User**. The app copies itself to `~/Applications/CookieMonster.app`, opens the installed copy, and quits the disk-image copy. No administrator authorization, system-wide symlink, or shell-profile change is required. Eject the disk image after the installed app opens, then complete WPP SSO.

If macOS uses App Translocation, the app asks for manual installation rather than guessing the original bundle location. In Finder, open your home folder, create `Applications` if needed, and copy `CookieMonster.app` there. Open that copy and eject the image. ZIP downloads also use this manual copy procedure.

Existing apps are never replaced automatically. To update, quit CookieMonster, move the existing user-owned app aside in Finder, then install the new copy. Keep the previous copy until the new version has been verified. A failed copy can leave a partial bundle; inspect it before removing it. Application settings and WPP browser data remain separate from the app bundle.

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

The manual macOS workflow uses `CM_UNSIGNED=1`. It validates copying the DMG app into a disposable directory under the user's home, private executable availability, rejection of an existing destination, reinstallation after removal, and cleanup without system-wide installation. It uploads only the DMG. The default `publish=false` does not publish a release; `publish=true` explicitly publishes after validation.

These checks do not prove Gatekeeper acceptance, Finder launch, or a WPP-backed request. Before distributing a signed build, test on the intended standard-user Mac: install into `~/Applications`, launch after ejecting the DMG, complete SSO, send a prompt, restart, and confirm no administrator installation prompt or public CLI dependency. Verify the signed app and notarization with macOS tooling. Native checks cannot run on a Windows development host.
