# Password security

Status: hardened implementation with regression coverage and an [independent agent code review](password-review.md), **not an externally audited password manager**. Chromium-equivalent security has not been established. Security parity is a release requirement to assess against an explicit threat model, not a claim justified by encryption or passing tests alone.

## Reused components and boundaries

- Node `crypto` / OpenSSL: AES-256-GCM, random keys and nonces. CookieMonster implements the storage envelope and integration, not the cryptographic primitives.
- Electron `safeStorage`: OS protection for each vault key. No plaintext fallback is permitted.
- Electron isolated worlds: fixed form inspection/fill code; page JavaScript has no desktop preload or vault API.
- Electron native dialogs: explicit, default-cancel save/fill consent showing origin and account. This is user consent, **not OS identity reauthentication**.
- OS reauthentication before unlocking: Windows Hello through Microsoft's `IUserConsentVerifierInterop` (only `Verified` succeeds), and Electron Touch ID on supported Macs. The Windows helper receives no credentials or encryption keys. Unsupported devices, Linux, cancellation, missing helpers and errors remain locked; there is no ordinary-dialog fallback.
- `csv-parse`: standard password export parsing; parser failures are replaced with a generic error that cannot echo records.

## Controls implemented

| Threat                                           | Control                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Reading stored credentials without the OS key    | Entire credential payload encrypted, including origin, username and ID                                    |
| Editing a credential's destination or ciphertext | GCM authenticates the complete payload; unreadable data is not silently overwritten                       |
| Renderer access through generic settings         | Private browser namespace denied for get/set/delete/clear/keys/length, including Windows filename aliases |
| Page navigation during consent or filling        | Tab revision checks and one-use document-local tickets in the isolated world                              |
| Form replacement between inspection and delivery | Revalidate field identities, visibility, types and submission destination                                 |
| Hidden fields, ambiguous forms, credential URLs  | Reject obscured/invisible fields, multiple candidates, cross-origin actions and GET submissions           |
| Concurrent agent consent and password delivery   | Invalidate pending grants; block new grants while login operations are pending                            |
| Unintended password use from app renderer        | Each fill requires native consent; no password returned to app renderer; no automatic submission          |
| Local remote-debugging access                    | Development debug port opt-in; vault unavailable when port/pipe switches are present                      |
| Malformed/oversized imports                      | Bounded reads, batch validation, generic errors and atomic vault replacement                              |
| Interrupted migration or deletion                | One atomic store replacement updates the vault and removes legacy credential records                      |

Passwords necessarily reach the destination website after an approved fill. Website scripts can read, copy, reveal or transmit them. Field checks cannot defend against a compromised destination or XSS on the correct origin. Turning on agent access later grants access to that site's content; password-field snapshot redaction is not general data-loss prevention.

## Remaining security limits

The vault starts locked. Successful OS verification grants a fixed five-minute window using a monotonic clock; passive status updates never extend it. Metadata, migration, reads, writes, saving, filling, deleting individual logins and importing passwords require an unlocked vault. Manual lock, OS lock/suspend, hiding/minimizing/closing an app window and renderer teardown lock it again. Lock generations invalidate pending authentication and asynchronous operations, even after another unlock. Explicit clear-all remains available while locked or corrupt with confirmation.

Locking prevents subsequent dispatch and clears account metadata from UI state. It cannot recall a credential-bearing script already dispatched to Chromium or a password already delivered to the page. Scripts check an execution deadline capped at five seconds and the remaining unlock interval; manual locking during that already-authorized interval is not a remote cancellation guarantee. Locking does not sign out websites or clear forms already filled.

1. **Windows same-user processes:** Electron's DPAPI model does not protect vault keys from other applications running as the same user. A native confirmation dialog does not fix this. App-bound key protection or a separately unlocked vault needs an evaluated design before claiming stronger local-process protection.
2. **App-level reauthentication versus key protection:** OS reauthentication and locking are application access controls. They do not change DPAPI/keychain cryptographic protection. There is no separate master password or hardware-bound vault key; the OS login/keychain remains the at-rest boundary.
3. **Local tools are not sandboxed by the browser permission switch:** a shell-capable agent or debugger running as the user is outside the browser-tool boundary and inherits the local-process limitation above.
4. **Memory and disk remnants:** temporary byte buffers are cleared where practical, but JavaScript strings and Chromium's delivered form values cannot be reliably wiped. Existing backups, filesystem remnants and user-created CSV exports are not securely erased.
5. **Legacy migration:** old records had unauthenticated plaintext origin/username metadata. Migration preserves their current contents and cannot establish that they were never altered before migration. Do not run an older build against a migrated profile: it does not understand this vault format.
6. **Availability and rollback:** local deletion, replacement with an older valid vault, OS-key loss and hostile same-user processes are not prevented. Corruption is surfaced without automatically resetting data; explicit clear-passwords remains available.

## Evidence and release work

The isolated Electron harness exercises real OS encryption on Windows and actual Chromium pages with synthetic credentials. Coverage includes save/fill, origin mismatch, ciphertext tampering without destructive recovery, legacy migration, default-cancel consent, cross-origin/GET/formaction rejection, invisible/overlaid fields, duplicate usernames, field replacement, same-origin document replacement and navigation during confirmation. Unit tests cover private-store filename aliases and secret-free CSV errors.

Automated tests simulate native dialog choices and the authentication ceremony in a separate fixture process; production exposes no bypass flag. Tests cover startup denial, authentication failure, concurrent authentication, stale completion after locking, expiry without timer delivery, lock/re-unlock invalidation, metadata removal, OS lock/suspend events, hiding the app and an import interrupted by locking.

On 2026-09-15, `bun scripts/vault-auth-smoke.ts` completed the actual Windows Hello flow through the compiled helper and production authentication adapter and returned `VERIFIED`. It uses a separate window and never accesses saved passwords. macOS Touch ID, Linux keychain recovery and packaged installer execution have not been validated in this Windows session. These checks do not establish resistance to a compromised renderer/main process, local malware, screen capture, all form variations or physical authentication attacks.

Before production password-manager assurance: agree the supported local-process threat model; obtain external review where required; and exercise macOS authentication, packaged helper integrity, platform keychain failures and recovery. Do not describe this implementation as equivalent to Chromium or externally audited before that work is complete.

Primary reference: [Electron safeStorage security semantics](https://www.electronjs.org/docs/latest/api/safe-storage).

## Account management work (#5, #34)

Windows-first account creation and replacement use a separate `windows-entry` helper with native CredUI controls. No existing password is sent to this helper. The entered value returns only through the child process pipe to main; child errors are replaced with secret-free errors and returned buffers are cleared. CredUI is configured not to persist credentials. OS vault unlock still precedes entry, and default-cancel native consent precedes persistence. Editing preserves the selected ID, rejects duplicate origin/username pairs and detects concurrent changes. The UI receives metadata only.

Native entry is currently Windows-only. CredUI accepts at most 513 username and 256 password UTF-16 units. Longer imported usernames start with an empty entry field so the user can explicitly replace them rather than silently truncate them; imported values remain intact on cancellation. macOS entry is not implemented; no renderer fallback is provided.

`bun scripts/browser-smoke.ts --accounts` is the focused synthetic fixture: actual encrypted storage, stubbed entry/OS ceremony/native consent, create/edit, duplicate and conflict rejection, cancellation, lock/re-unlock races, corrupt ciphertext/key/version refusal, and migration. Setter-failure injection verifies failure propagation and unchanged data **before persistence**, not crash-during-write durability or partial filesystem replacement. Those storage-level tests remain outstanding.

Remaining evidence: actual CredUI success/cancellation and Unicode round-trip, child termination on lock, packaged helper integrity and upgrades, macOS implementation/validation, storage-level interruption/reopen tests, agreed same-user-process threat model, and external security review. The full isolated browser smoke now passes after test-only Windows occlusion handling and a bounded wait for Chromium's cancelled-download cleanup. Neither #5 nor #34 is complete.

Native reference: [Microsoft CredUIPromptForCredentialsW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-creduipromptforcredentialsw).

## Contact autofill (#6)

Contacts use OS-encrypted storage, separate from passwords, and the same unlock window. The app renderer receives contact data for editing only while unlocked; the agent browser plugin has no contact API. Explicit native preview lists the exact origin and field values before filling. Supported targets are visible top-frame fields with explicit autocomplete tokens in one unambiguous section/form, same-origin POST destinations, and exact select option values. International parts are preserved without US-specific rearrangement; multiline addresses require a textarea.

The isolated `bun scripts/browser-smoke.ts --contacts` fixture covers encrypted CRUD, stale revisions, corrupt-data preservation without disabling healthy passwords, cancellation, hidden/disabled/ambiguous fields, document/form replacement, navigation, lock/re-unlock, detached views, edits during delivery, and South African/Japanese address shapes. Authentication and dialog choices are simulated, not native UI evidence.

Contact changes are refused during final delivery. Like password filling, an already-dispatched script cannot be recalled on manual lock; its execution deadline is at most five seconds and never exceeds the unlock window. This is not instantaneous revocation. Native long/multiline/RTL preview readability, keyboard interaction and supported macOS/packaged builds still need validation. No browser-security parity claim is made.

## Registration and password changes (#7)

Automatic offers support one or two explicitly marked `autocomplete=new-password` inputs, with equal nonempty values when there are two, and optionally one explicit `current-password`. All password inputs must be visible and usable. Inputs marked `current-password` or `new-password` remain credentials regardless of display type: revealed/non-password-type credential inputs cause rejection and never become username candidates. Mixed marked/unmarked passwords, overlapping current/new tokens, multiple current passwords, mismatched confirmation and ambiguous usernames are rejected rather than guessed from field order. Only the new value is captured for these forms; the current password is not sent to main or used to identify an account.

A visible unambiguous username is confirmed in the existing native origin/account consent. Without a username, an additional default-cancel native chooser requires explicit selection from exact-origin saved accounts, even when there is only one. It shows at most five accounts, with complete usernames of at most 80 UTF-16 units and no control/format characters; empty, duplicate or oversized lists are refused, not truncated. Larger/unusable lists require manual account editing. Previous username-only login steps never supply the account for a new-password form. Selection alone never saves: final default-cancel confirmation follows, and concurrent edits are checked against the pre-selection credential snapshot.

Capture remains in the dedicated isolated world and main-process CDP binding, with secure-context, top-frame, same-origin POST and private-tab (agent access off) checks. Offers never submit a form. Every trusted resubmission replaces the pending attempt, including rejected submissions. Trusted `invalid` events for the form associated with the recent user gesture also revoke the candidate when browser constraint validation prevents `submit`; the isolated world sends only `null`, without reading or transmitting field values. Consumed/discarded offers release all retained password input references. Vault lock/re-unlock, navigation during either dialog and tab selection revoke consent. Existing success detection is a heuristic (form removal or same-origin navigation, no visible password/error fields, no observed load failure), not proof that the website accepted the password; final copy explicitly requires the user to confirm success.

The focused `bun scripts/browser-smoke.ts --registration` fixture uses actual Chromium trusted input, the production watcher/binding/consent seam and Windows OS-encrypted storage with synthetic credentials. It covers matching registration, visible-account changes, explicit selected-account updates, exact-origin filtering, old-secret/previous-step non-inference, reference release, mismatch, ambiguity, failed submissions, stale invalid resubmission, cancellation, lock/navigation/tab-selection races at both dialogs, concurrent edits, bounded selection and agent-access rejection. Dialog responses and OS authentication are stubbed in this separate process; this is not native chooser usability, Windows Hello, macOS, packaged-build or external-review proof. New copy uses complete typed native i18n keys with the existing English fallback; locale translations remain follow-up work. Review native keyboard/screen-reader behavior and long/RTL account readability before broader release. Follow-up regressions cover revealed current-password fields, revealed mismatching confirmation, and `required`/`pattern`/`setCustomValidity` failures after a captured prior attempt. Binding counters verify no credential delivery for rejected revealed forms, invalid validation events, locked vaults or agent-enabled tabs, without retaining/logging payloads. Concurrent-edit checks assert both the ID and password of the current exact-origin/username record after either dialog; temporarily removing the conflict guard made the dialog-1 password-retention assertion fail, and the guard was restored. The full isolated native suite also passed after these review fixes. This verifies fixture behavior, not packaged-platform or native-dialog usability.

## Multi-step filling

Explicit username-only and password-only actions retain the same exact-origin, vault-grant, visible-field and document-ticket checks. Native consent names the selected field and account. Only the requested field is serialized into the delivery script; username-only filling never sends the saved password. Cross-origin steps and iframe filling remain unsupported. The native fixture verifies both steps, missing-field rejection, and cross-origin form action rejection with synthetic credentials.
