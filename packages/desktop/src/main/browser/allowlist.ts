// The allowlist is authoritative in main because main owns the WebContents and the sidecar cannot
// be trusted to police itself. Its own file, not a key in opencode.json, so the sidecar can never
// rewrite the hosts it is allowed to act on.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { DEFAULT_ALLOWLIST, allowlistPath, hostAllowed, parseAllowlist } from "@cookiemonster/cm-browser/protocol"

/** Seeds the file on first boot, then always reads what is on disk so user edits win. */
export function loadAllowlist(path = allowlistPath()): readonly string[] {
  if (!existsSync(path)) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(DEFAULT_ALLOWLIST, null, 2)}\n`)
    } catch {}
    return DEFAULT_ALLOWLIST
  }
  try {
    return parseAllowlist(JSON.parse(readFileSync(path, "utf8"))) ?? DEFAULT_ALLOWLIST
  } catch {
    // ponytail: unreadable or malformed file falls back to defaults rather than allowing everything.
    return DEFAULT_ALLOWLIST
  }
}

export const allowed = (url: string, path = allowlistPath()) => hostAllowed(url, loadAllowlist(path))
