# Password manager security review

Date: 2026-09-15

Reviewer: a separate Codex agent, independently inspecting the implementation and reporting findings to the implementing agent. This is **an independent agent code review, not an external security audit, penetration test, or Chromium-equivalence certification**.

## Scope and result

Reviewed the working-tree implementation, including untracked files: vault encryption and migration; vault access/session/authentication; the Windows native authenticator and its build/package wiring; profile operations; form inspection/delivery; tab IPC ownership and lifecycle handling; private generic-storage restrictions; and password controls in the app UI.

**No unresolved actionable security findings identified within that reviewed scope after the fixes below.** This conclusion applies to code inspection and the stated threat model, not an assurance that vulnerabilities are absent.

## Findings addressed

- **Metadata at expiry:** a profile snapshot could gather usernames/origins before expiry, then return them with a locked status after expiry. The implementation now captures the access generation, rechecks it after collecting metadata, and returns metadata and status together as the final profile operation. Reinspection confirms the reported inconsistency is addressed.
- **Delayed delivery boundary:** checking after a Chromium script completes cannot recall a secret already dispatched to that renderer. The implementation adds a short page-side delivery deadline, capped by remaining vault access time. Manual locking still cannot recall an already-dispatched script or erase values already delivered to a site; this remains a documented boundary rather than a cancellation guarantee.

## Controls inspected

- Startup is locked. Unlock requires successful OS verification; cancellation, unavailable authentication, helper errors and timeout fail closed.
- The five-minute access window uses a monotonic clock and is not extended by passive state publication. Vault API calls enforce expiry even before timer delivery.
- Lock generations invalidate pending unlocks and asynchronous import/save/fill operations. Reads, writes and legacy migration require unlocked access. Final reinspection also confirmed generation checks after cryptography, before returning decrypted records or persisting a new vault.
- OS lock/suspend, app shutdown, owner hiding/minimizing and renderer teardown trigger locking. Locked snapshots omit credential metadata.
- Windows native authentication accepts only the `Verified` result. The macOS path requires Touch ID availability and successful completion. There is no production IPC or environment authentication bypass.
- Generic renderer storage cannot address the private browser namespace; form delivery retains origin, document, field, visibility and agent-access checks.

## Evidence and limitations

The reviewer independently ran eight tests across `vault-access.test.ts`, `store-keys.test.ts` and `import-data.test.ts`: **8 passed, 0 failed**. These cover lock state, cancellation, synchronous expiry, generation invalidation, private-store aliases and bounded/secret-free import handling.

The reviewer did not independently perform a successful physical Windows Hello or Touch ID authentication, validate every supported OS, run a packaged installer, or perform a penetration test. The implementing agent owns additional native-harness and platform test results; they are not substituted for independent verification here.

The implementing agent subsequently reported successful interactive Windows authentication through the production adapter and native helper (`VERIFIED`), plus a passing native browser harness covering OS lock/suspend events, owner hiding, and lock/reunlock during fill confirmation and import selection. These are attributed implementation-team results, not tests independently repeated by this reviewer. Touch ID and packaged-installation validation remain outstanding.

Windows DPAPI same-user process access remains outside the protection offered by the application lock. A compromised main process, local shell-capable agent, compromised destination website, renderer-held metadata already observed while unlocked, and residual JavaScript strings are not made safe by this change. Native consent wording is renderer-localized and is not an independent trust boundary against a compromised app renderer.

Microsoft documents the Windows interop method as verifying the logged-on user through an application window. No explicit same-process HWND requirement was found in the inspected documentation. The implementing agent observed the helper successfully authenticate using Electron's cross-process HWND on this Windows machine; the reviewer did not independently repeat that interaction. The method documentation lists Windows build 22000 as its minimum supported client.

References: [Microsoft interop API](https://learn.microsoft.com/en-us/windows/win32/api/userconsentverifierinterop/nf-userconsentverifierinterop-iuserconsentverifierinterop-requestverificationforwindowasync), [Microsoft UserConsentVerifier](https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.ui.userconsentverifier), [security model](password-security.md).

## Multi-step follow-up review � 2026-09-15

The independent reviewer inspected the explicit username/password-only expansion and checked generated scripts. No new secret-delivery or targeting bypass was found. The reviewer recommended naming the selected field in native consent; this wording was added. The implementing agent separately ran the real Chromium multi-step fixture with synthetic credentials. This remains an agent code review, not an external security audit.
