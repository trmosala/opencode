import { test, expect } from "bun:test"
import { recoveryNavigation, projectSavedTab, projectRecoveryGroups } from "./tab-recovery"

test("recovery projects URL/title only, bounds history around selection, and preserves legacy records", () => {
  const entries = Array.from({ length: 40 }, (_, i) => ({
    url: `https://example.test/${i}`,
    title: `${i}`,
    pageState: "synthetic-secret",
    postData: "synthetic-secret",
  }))
  for (const activeIndex of [0, 19, 39]) {
    const navigation = recoveryNavigation({ entries, activeIndex })!
    expect(navigation.entries.length).toBe(20)
    expect(navigation.entries[navigation.activeIndex].url).toBe(entries[activeIndex].url)
    expect(JSON.stringify(navigation)).not.toContain("synthetic-secret")
  }
  const legacy = { url: entries[0].url, title: "legacy" }
  expect(projectSavedTab({ ...legacy, pinned: true })).toEqual({ ...legacy, pinned: true })
  for (const navigation of [
    null,
    {},
    { entries, activeIndex: -1 },
    { entries, activeIndex: 40 },
    { entries, activeIndex: 0.5 },
    { entries: Array(101).fill(legacy), activeIndex: 0 },
    { entries: [{ url: "javascript:alert(1)", title: "" }], activeIndex: 0 },
  ]) {
    expect(projectSavedTab({ ...legacy, navigation, agentAccess: true })).toEqual(legacy)
  }
  const group = { sessionID: "test", tabs: [legacy], active: 0, closed: [{ ...legacy, id: "closed", time: 1 }] }
  expect(projectRecoveryGroups([{ ...group, pageState: "secret" }])).toEqual([group])
  for (const value of [null, {}, [{ ...group, active: 1 }], [{ ...group, tabs: Array(33).fill(legacy) }]]) {
    expect(() => projectRecoveryGroups(value)).toThrow()
  }
  expect(() => projectRecoveryGroups([{ ...group, tabs: [{ ...legacy, pinned: "yes" }] }])).toThrow()
  expect(projectSavedTab({ url: "https://user:pass@example.test/", title: "" })).toBeUndefined()
  const long = { url: `https://example.test/${"x".repeat(4096)}`, title: "Legacy long URL" }
  const legacyGroup = { sessionID: "legacy", tabs: [long], active: 0, closed: [{ ...long, id: "old", time: 1 }] }
  expect(projectRecoveryGroups([legacyGroup, group])).toEqual([legacyGroup, group])
  expect(recoveryNavigation({ entries: [long], activeIndex: 0 })).toEqual({ entries: [long], activeIndex: 0 })
})
