#!/usr/bin/env bun
import { $ } from "bun"

import { resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../opencode && bun script/build-node.ts`

// The sidecar is plain Node and cannot import TypeScript, so the browser-control plugin ships as a
// bundled .mjs. Without this the tools silently never register.
await $`bun run --cwd ../cm-browser build`
