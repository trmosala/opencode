import type { DriverContents } from "./driver"

const active = new WeakMap<DriverContents, { count: number; throttling: boolean }>()

// Context capture and agent input can overlap on the same tab.
export function keepBrowserRendering(contents: DriverContents) {
  if (typeof contents.backgroundThrottling !== "boolean") return () => {}
  const lease = active.get(contents) ?? { count: 0, throttling: contents.backgroundThrottling }
  lease.count++
  active.set(contents, lease)
  contents.backgroundThrottling = false
  return () => {
    if (--lease.count) return
    active.delete(contents)
    if (!contents.isDestroyed()) contents.backgroundThrottling = lease.throttling
  }
}
