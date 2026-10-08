# OpenCode Desktop

The OpenCode Desktop app, built with Electron.

## Development

```bash
bun install
bun dev
```

## Build

Run the `build` script to build the app's JS assets, then `package` to
bundle the assets as an application. The resulting app will be in `dist/`.

```bash
bun run build && bun run package
```

## Saved WPP logins

In CookieMonster's visible WPP Okta sign-in window, use the **WPP login** menu on macOS or right-click the page:

- **Save WPP account...** opens native account entry. Enter your work email and Okta password, then confirm saving once.
- When Okta shows **Verify with your password**, CookieMonster automatically fills the empty password field for the matching saved work email. There is no account picker or fill-confirmation dialog. A locked vault uses OS authentication first. CookieMonster leaves an entered password alone and never clicks Verify or completes MFA.
- **Use saved login...** remains available for manually filling the username screen or retrying recall after cancellation.
- **Manage saved WPP accounts...** updates or forgets an account. These actions change the shared CookieMonster password vault, not your password or SSO session on WPP.
- **Lock saved passwords** immediately locks the vault. It also locks after five minutes, screen lock, suspend, or app shutdown.

Filling is limited to the verified widget at `https://wpp.okta.com` in an interactive login window. Worker windows have no saved-login controls. A password fill must match exactly one saved account for the email already selected in Okta. Navigating, hiding or minimizing the window, replacing fields or changing the saved account, or locking the vault cancels pending delivery. Cancelling automatic unlock does not repeatedly prompt on the same password screen. Automatic password capture and save prompts remain separate and are not enabled for this window.

macOS unlock uses system device-owner authentication, including Touch ID or the Mac login password. CookieMonster does not receive the Mac password. The authentication and account-entry helpers build during `predev` and `prebuild`; packaged builds include them. For CookieMonster builds, always set `CM_BRAND=1`.

Linux development uses Electron's secure desktop keyring instead of a fresh device-password challenge. If that keyring is already unlocked, recall requires no extra unlock dialog. Plaintext `basic_text` and unavailable keyring backends are rejected. Saving an account uses `/usr/bin/zenity` with a masked password field; install Zenity if it is missing. macOS remains the CookieMonster release target.

From `packages/desktop`, verify the isolated Okta form fixture with `bun scripts/wpp-login-smoke.ts`. It uses synthetic fields and credentials and intercepts HTTPS in a disposable Electron partition, without contacting WPP. On a Mac, run `bun scripts/build-vault-auth.ts`, then `bun scripts/vault-auth-smoke.ts` to check the real device-authentication prompt. Test both successful authentication with the Mac login password and cancellation, using `CM_VAULT_AUTH_EXPECT=cancelled` for the latter.
