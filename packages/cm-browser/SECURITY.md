# Browser bridge trust and resource limits

The authenticated local OpenCode backend is trusted to identify sessions. Session IDs
are routing identities, not credentials. Desktop main owns browser grants and checks
task/tab ownership, revocation and delivery authority. Delegated child requests retain
their existing admission checks. Isolation after compromise of the shared backend is
outside this guarantee: per-task secrets held by that same backend cannot provide it.
This records the trust decision for trmosala/opencode#83.

CookieMonster starts the managed service without a hostname override. Server process
startup defaults to 127.0.0.1, and desktop setup requires Basic authentication. The
all-interface override applies only to isolated non-CookieMonster development builds.
Explicit custom server exposure requires a separate review.

Request envelopes have a 128 KiB UTF-8 JSON budget, including unused fields and routing
metadata. This accommodates 10,000 characters of escaped text (up to 60,000 bytes) and
the existing 8 KiB site-tool argument budget. Sender admission checks before transmission;
desktop checks before parsing the inner JSON. Invalid or oversized inbound messages
close the channel. The outer SSE/RPC allocation already exists at this point: this is
not a transport-level or process-wide memory bound. Response limits are unchanged.

Each sender port and desktop bridge allows 256 ordinary outstanding requests plus 16
reserved revocation slots. Cancellation remains available at capacity. Overload returns
an unavailable result. Sender waiters are removed on completion, cancellation, timeout
or disconnect. Desktop native operations occupy capacity until settlement even after a
cancellation/timeout reply, because aborting does not prove native work has stopped.
Bridge shutdown aborts work and clears tracking. Duplicate IDs preserve original waiters.

Existing router, delegation, bridge and session-resolver tests cover foreign tabs,
revoked grants, failed session lookups, delivery authority and valid operations. Wire
and port tests cover request size and admission limits. No capability system or worker
isolation is introduced; the separate transcript/CDP leak investigations are unchanged.
