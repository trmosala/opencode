import { benchmark, expect } from "../benchmark"
import { measureNavigationMilestones } from "./navigation-milestones"
import { fixture } from "./session-timeline-stress.fixture"
import { installStressSessionTabs, mockStressTimeline, stressSessionHref } from "./timeline-test-helpers"

benchmark("opens a CM3 sidebar session", async ({ page, report }) => {
  await mockStressTimeline(page)
  await installStressSessionTabs(page, { sessionIDs: [] })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, quietCompanion: true } }))
  })
  await page.goto("/")
  const recent = page.getByRole("region", { name: "Recent sessions", exact: true })
  const target = recent
    .getByRole("group", { name: fixture.expected.targetTitle, exact: true })
    .locator('[data-action="recent-session"]')
  await expect(target).toBeEnabled()
  report(
    await measureNavigationMilestones(page, {
      triggerSelector: '[data-action="recent-session"]',
      milestones: {
        composer: { selector: '[data-component="prompt-input"][contenteditable="true"]' },
        selected: { selector: '[data-action="recent-session"][data-active="true"]' },
      },
      navigate: async () => {
        await target.click()
        await expect(page).toHaveURL(stressSessionHref(fixture.targetID))
        await expect(page.locator('[data-component="prompt-input"][contenteditable="true"]')).toBeEditable()
      },
    }),
  )
})
