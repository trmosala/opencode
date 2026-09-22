# Future credential and sync proposals

Status: discovery only, 2026-09-18; target updated 2026-09-22. macOS is now the sole CookieMonster target. Windows API references below are historical background, not an implementation or validation requirement. Platform acceptance gates apply to supported macOS builds. Payment autofill, CookieMonster-managed passkeys and cross-device sync are absent. This document does not authorize implementation and there are no disabled controls implying support. Each proposal needs separate product acceptance, platform validation and security review before engineering starts.

## 1. Payment autofill

### Recommendation

Do not build a CookieMonster card vault. Keep the existing contact/address autofill, let websites and approved payment providers own checkout, and investigate a native payment-handler integration only if WPP identifies a concrete internal user need and approves the compliance boundary. Never store or sync primary account numbers (PANs) or card verification codes in the current vault.

### User value and supported surface

Address and contact filling already removes much of the repeated checkout entry without creating a cardholder-data store. The web [Payment Request API](https://www.w3.org/TR/payment-request/) lets a user agent mediate between a merchant, a user and a payment method, including tokenized or system-authenticated methods. Chromium documents browser-managed address and payment autofill, but those Chrome profile services and settings are not public Electron APIs. Electron exposes a `payment-handler` permission category, not a Chrome card-vault management interface. CookieMonster therefore cannot honestly “borrow Chrome autofill” through a supported Electron API.

The only acceptable engineering spike would use a processor or wallet's supported payment handler and return its provider token/cryptogram directly to the requesting merchant. It must first prove that the exact provider works in CookieMonster's persistent private Electron partition, displays provider-owned native confirmation, binds the merchant origin and transaction details, and never exposes PAN/CVC to CookieMonster renderer, main-process logs, stores, agent tools or sync. [Secure Payment Confirmation](https://www.w3.org/TR/secure-payment-confirmation/) may strengthen a provider flow, but it is a WebAuthn extension and payment-method feature, not a card vault.

### Security and acceptance gates

- Written product need, approved payment provider and supported countries/networks.
- PCI scope determined in writing by WPP security/compliance and an appropriate qualified reviewer. PCI SSC states that systems storing, processing, transmitting, or able to affect cardholder data fall within the cardholder-data environment; encryption alone does not remove that scope.
- No PAN, CVC, track data, PIN, raw processor response, or reusable bearer token in browser storage, telemetry, crash reports, screenshots, clipboard, agent context or backups.
- Exact top-level merchant origin, secure context, real transient user activation and provider-owned confirmation. Cross-origin payment frames require provider-specific evidence; ordinary contact-fill consent cannot authorize card delivery.
- Cancellation, navigation, renderer loss, duplicate submission, retry/idempotency, amount/currency changes and post-confirmation settlement tested against a provider sandbox and reviewed native UI.
- Packaged Windows and macOS validation, accessibility/localization review, incident response and key/token revocation procedures.

Until those gates are accepted, payment-specific controls remain absent. The existing contact editor must not be relabeled as payment autofill.

## 2. Passkey management

### Recommendation

Support website WebAuthn by delegating private-key custody and user verification to the operating system or roaming authenticator. Do not make CookieMonster a passkey manager. A separate first proposal may add trustworthy account-selection mediation for site WebAuthn; credential enumeration, export, synchronization and private-key storage stay with the OS/provider.

### User value and supported surface

Pass-through WebAuthn would let users sign in to sites with Windows Hello, security keys, or macOS Touch ID without storing a password in CookieMonster. Electron's current [`Session`](https://www.electronjs.org/docs/latest/api/session#event-select-webauthn-account) emits `select-webauthn-account` when multiple discoverable credentials need selection and cancels the request if no listener answers. On macOS, [`app.configureWebAuthn`](https://www.electronjs.org/docs/latest/api/app#appconfigurewebauthnoptions-macos) enables a Touch ID authenticator with a signed keychain-access-group entitlement; Electron documents those credentials as Secure-Enclave device-bound and not iCloud-synced. Windows provides supported Win32 [WebAuthn APIs](https://learn.microsoft.com/en-us/windows/win32/webauthn/-webauthn-portal) for Windows Hello and FIDO2 authenticators. The WebAuthn model keeps credentials scoped to a relying-party ID and requires authenticator-mediated consent.

A CookieMonster WebAuthn slice would register one main-process session listener, show only bounded account metadata in a native default-Cancel chooser, bind the request to the exact selected private tab/frame/relying-party ID and current document, invoke the callback exactly once, and cancel on navigation, selection change, hide/minimize/close, timeout or renderer loss. It would never expose credential IDs, assertions, attestation objects, account metadata or challenges to agent tools, screenshots, history or logs beyond the bytes Chromium must return to the requesting relying party.

### Why a CookieMonster passkey manager is deferred

Managing passkeys is a different product from mediating site WebAuthn. Windows 11 24H2 has native plugin passkey-manager APIs, but implementing them requires a registered native authenticator, COM callbacks, Windows Hello user verification, credential metadata lifecycle, offline behavior and system-level installation. Apple's equivalent is a signed Authentication Services credential-provider extension with associated-domain and entitlement work. These platform plugins are not Electron wrappers and have different storage, sync, recovery and review requirements. A cross-platform JavaScript vault must not emulate them or export private passkey material.

### Security and acceptance gates

- A native spike proves create/get, multiple-account selection, roaming security keys, conditional UI and cancellation on each target OS without page or agent interception.
- Relying-party ID, requesting origin, frame identity, secure context, selected tab, user activation and navigation lifecycle are verified in main around every await. Cross-origin iframe rules follow WebAuthn, rather than reusing ordinary autofill policy.
- macOS has stable signing identity and matching keychain entitlement; Windows has documented minimum OS versions and installer behavior. Device-bound and synced credentials are described accurately per platform.
- Attestation policy, enterprise attestation, account metadata privacy, logging/crash handling, authenticator removal, recovery and site error UX receive security/privacy review.
- Packaged Windows/macOS, real authenticators, accessibility, localization and authenticated-site tests pass. No “Manage passkeys” UI ships unless native enumeration/deletion is both supported and independently reviewed.

## 3. Cross-device sync

### Recommendation

Do not sync the existing profile database or OS-wrapped vault. If WPP funds a sync service, start with versioned bookmarks/preferences, then consider separately reviewed end-to-end encrypted passwords and contacts. Cookies, browsing history, downloads, restored tabs, site permissions, agent grants, passkeys, payment data and WPP/app sessions remain local.

### User value and supported surface

Sync could reduce repeated setup across managed computers and recover bookmarks or credentials after device replacement. Electron has no Chromium Sync service API. Its persistent [`Session`](https://www.electronjs.org/docs/latest/api/session) is local to a partition, and [`safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage) protects local strings with platform-dependent OS facilities; Electron explicitly describes Windows DPAPI as protection from other users on the same machine, not other applications in the same user space. Neither API supplies cross-device identity, conflict resolution, recovery, revocation or a remote service.

The recommended design is an application protocol, not profile-file copying:

1. WPP SSO authorizes access to an opaque account namespace but is not an encryption key.
2. Each device generates an asymmetric device key. Its private key is OS-protected locally and never uploaded.
3. A random sync root key encrypts versioned item envelopes client-side. Device enrollment wraps that root key to an approved device through explicit device-to-device approval or a separately stored recovery key.
4. The service stores ciphertext, opaque item IDs, authenticated revision metadata and tombstones. It cannot decrypt item names or values.
5. Items use stable IDs and per-item revisions. Deterministic conflict rules preserve both conflicting secret changes for user review; deletion tombstones and server monotonic checkpoints prevent silent resurrection/rollback.
6. Import into the local vault still requires fresh OS authentication and its existing validation/collision limits. Removing a device revokes future service access and rotates/wraps keys according to a documented compromise procedure.

### Security and acceptance gates

- A named service owner, data residency/retention policy, SSO authorization model, availability target, audit trail and deletion contract.
- Reviewed protocol specification covering key generation, authenticated encryption and context binding, device enrollment, recovery, rotation, revocation, downgrade/rollback protection, conflict handling, quotas and schema migration. No custom cryptographic primitive.
- Explicit recovery choice: recovery key, approved-device transfer, or irrecoverable loss. Support staff and the service must not silently decrypt vault data. Lost-device, stolen-session, malicious-server, replay, clock skew and simultaneous-edit threat cases are tested.
- Strict category allowlist. Secret sync is separate from nonsecret settings; local-only categories cannot enter ciphertext envelopes accidentally. Backups and sync have independent keys and lifecycle.
- Offline queue bounds, idempotent upload/download, partial failure, interrupted rotation, account deletion, device-list UX and verification of server acknowledgements.
- Independent protocol/implementation security review plus packaged Windows/macOS validation before password/contact sync. A second explicit product decision is required after nonsecret sync evidence.

Until a service and these choices exist, the encrypted manual backup is the only portable password recovery path and no Sync control should appear.

## Decision record

| Area              | Current decision                     | Earliest acceptable next step                               |
| ----------------- | ------------------------------------ | ----------------------------------------------------------- |
| Payment autofill  | Decline a local card vault           | Provider/payment-handler feasibility and compliance review  |
| Passkeys          | Delegate custody to OS/authenticator | Site WebAuthn mediation spike with native account selection |
| Cross-device sync | No profile or vault sync             | Backend/product threat model, then nonsecret sync protocol  |

These proposals intentionally separate “a Chromium engine can render the web API” from “Electron exposes a supported browser-product integration.” Feature acceptance must use the latter and real packaged evidence.
