# CookieMonster V2 runtime

The desktop runs the published OpenCode **2.2.5** server in its own Electron utility process. Its client, protocol, core and plugin dependencies use the same pinned release. The older `packages/server` and `packages/core` workspaces are not this runtime. They remain available to the legacy CLI and external V1 client support.

Electron supplies Node; an installed Bun executable is not required to run the desktop. Bun builds the adapters. The Node loader keeps the published stable Effect dependencies separate from the legacy desktop dependencies, including when loading plugins from packaged resources.

## Existing data

On first launch, `prepareDatabase` takes a SQLite backup of the existing channel database, including committed WAL data, into a sibling `*.cm-v2.db` file. Publication is exclusive, so another startup cannot replace it. The original database is retained. The official upstream V1 importer then imports history into the V2 database; only its SQLite reader is adapted for Node.

This is a one-time snapshot, not bidirectional synchronization. Stop using the V1 runtime before the final cutover. Subsequent V1 writes remain in the original database and are not copied into an existing V2 database. Do not delete either database to retry a migration. An import failure prevents the sidecar from reporting ready.

The desktop retains its local sidecar identity and session IDs, preserving client-side drafts, pins and settle/snooze placement. Scheduled tasks retain the existing `scheduling/schedules.json` store and its exclusive owner lock. If a V1 process owns that scheduler, V2 reports it unavailable rather than running a second scheduler.

## CookieMonster integrations

- CM Browser uses the native main-process IPC transport and existing grants/takeover controls. Its V2 plugin registers real tools. Browser tab delegation uses `browser_subagent`, since upstream's closed subagent input cannot carry the old extra field.
- WPP receives the process-owned runtime UUID and actual session ID on outgoing requests. Other providers retain upstream's real V2 identity.
- Scheduling and managed skills reuse the existing scheduler and safe filesystem implementation. Their authenticated extension routes preserve the app's existing payloads and review/revision checks. Workspace Reset uses the same authenticated boundary and rejects primary or unregistered workspaces.
- AE loads a directory plugin adapter around the unchanged vendored implementation. The adapter bridges the native panel's required client/event operations to V2. Staging validates both the original artifact inventory and the app-owned adapter bytes.

## Validation

Run from the named package directories:

```sh
# packages/cm-v2
bun run build
bun typecheck
bun test

# packages/cm-browser
bun test

# packages/app
bun run test:runtime

# packages/desktop
bun typecheck
bun test src/cm-ae.test.ts src/main/ae-artifact.test.ts
bun test src/main/wpp-bridge/
```

Runtime fixtures use the actual published server, native session execution and plugin APIs with isolated data. Model and AE-host responses are scripted locally; they do not qualify a live hosted model, WPP SSO, macOS After Effects, aerender or signed macOS distribution. Packaged Electron fixtures additionally exercise ASAR dependency loading and native parent-port communication.
