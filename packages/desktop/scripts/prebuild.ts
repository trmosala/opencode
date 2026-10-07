#!/usr/bin/env bun
import { $ } from "bun"

import { downloadCliToResources, resolveChannel } from "./utils"
import "./stage-cm-ae"
import "./build-vault-auth"

const channel = resolveChannel()
const assetChannel = process.env.CM_BRAND === "1" && channel !== "dev" ? "prod" : channel
await $`bun ./scripts/copy-icons.ts ${assetChannel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../opencode && bun script/build-node.ts`

// The sidecar is plain Node and cannot import TypeScript, so the browser-control plugin ships as a
// bundled .mjs. Without this the tools silently never register.
await $`bun run --cwd ../cm-browser build`

if (channel === "dev" || process.env.CM_BRAND === "1") await downloadCliToResources()
