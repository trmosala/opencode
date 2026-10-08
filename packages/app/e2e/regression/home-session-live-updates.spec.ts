import { expect, test } from "@playwright/test"
import type { Event } from "@opencode-ai/sdk/v2/client"
import { fixture, pageMessages } from "../performance/timeline/session-timeline-stress.fixture"
import { installStressSessionTabs } from "../performance/timeline/timeline-test-helpers"
import { mockOpenCodeServer } from "../utils/mock-server"

for (const quietCompanion of [false, true]) {
  test(`${quietCompanion ? "CM3 project sidebar" : "Home"} follows live session events across query providers`, async ({
    page,
  }) => {
    const events: Event[] = []
    await mockOpenCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages,
      events: () => events.splice(0).map((payload) => ({ directory: fixture.directory, payload })),
    })
    await installStressSessionTabs(page, { sessionIDs: [] })
    await page.addInitScript((quietCompanion) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, quietCompanion } }))
    }, quietCompanion)
    await page.goto("/")
    const rows = quietCompanion
      ? page
          .getByRole("complementary", { name: "Projects and sessions", exact: true })
          .locator('[data-action="project-session"]')
      : page.locator('[data-component="home-session-row"]')
    await expect(rows.filter({ hasText: fixture.expected.sourceTitle })).toBeVisible()

    const created = {
      ...fixture.sessions[0],
      id: "ses_live_home_index",
      title: "Live session created after Home loaded",
      time: { created: Date.now(), updated: Date.now() },
    }
    // Keep the list endpoint unchanged so refetching cannot hide a missed event.
    events.push({
      id: "evt_live_home_created",
      type: "session.created",
      properties: { sessionID: created.id, info: created },
    })
    await expect(rows.filter({ hasText: created.title })).toBeVisible()

    const updated = { ...created, title: "Live session renamed without reloading" }
    events.push({
      id: "evt_live_home_updated",
      type: "session.updated",
      properties: { sessionID: updated.id, info: updated },
    })
    await expect(rows.filter({ hasText: updated.title })).toBeVisible()
    await expect(rows.filter({ hasText: created.title })).toHaveCount(0)

    events.push({
      id: "evt_live_home_deleted",
      type: "session.deleted",
      properties: { sessionID: updated.id, info: updated },
    })
    await expect(rows.filter({ hasText: updated.title })).toHaveCount(0)
    await expect(rows.filter({ hasText: fixture.expected.sourceTitle })).toBeVisible()
    await expect(page).toHaveURL("/")
  })
}
