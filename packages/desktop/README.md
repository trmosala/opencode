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

- **Save WPP account...** opens native account entry. Enter your work email and Okta password, then confirm saving.
- **Use saved login...** unlocks the encrypted password vault, lets you choose an account, and asks before filling the current username or password field. Select it separately on each screen. Click Next or Verify and complete MFA yourself.
- **Manage saved WPP accounts...** updates or forgets an account. These actions change the shared CookieMonster password vault, not your password or SSO session on WPP.
- **Lock saved passwords** immediately locks the vault. It also locks after five minutes, screen lock, suspend, or app shutdown.

Filling is limited to the verified widget at `https://wpp.okta.com` in an interactive login window. Worker windows have no saved-login controls. A password fill must match the account already selected in Okta. Navigating, hiding or minimizing the window, replacing fields or changing the saved account, or locking the vault cancels pending delivery. Automatic password capture and save prompts are not enabled for this window.

macOS unlock uses system device-owner authentication, including Touch ID or the Mac login password. CookieMonster does not receive the Mac password. The authentication and account-entry helpers build during `predev` and `prebuild`; packaged builds include them. For CookieMonster builds, always set `CM_BRAND=1`.

From `packages/desktop`, verify the isolated Okta form fixture with `bun scripts/wpp-login-smoke.ts`. It uses synthetic fields and credentials and intercepts HTTPS in a disposable Electron partition, without contacting WPP. On a Mac, run `bun scripts/build-vault-auth.ts`, then `bun scripts/vault-auth-smoke.ts` to check the real device-authentication prompt. Test both successful authentication with the Mac login password and cancellation, using `CM_VAULT_AUTH_EXPECT=cancelled` for the latter.
