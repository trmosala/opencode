import { expect, test, type Page } from "@playwright/test"
import { fixture, pageMessages } from "../performance/timeline/session-timeline-stress.fixture"
import {
  installStressSessionTabs,
  mockStressTimeline,
  stressSessionHref,
} from "../performance/timeline/timeline-test-helpers"
import { mockOpenCodeServer } from "../utils/mock-server"

const composer = (page: Page) => page.locator('[data-component="prompt-input"][contenteditable="true"]')
const inbox = (page: Page) => page.getByRole("region", { name: "Inbox", exact: true })
const draftRow = (page: Page, title: string) => inbox(page).getByRole("group", { name: title, exact: true })

async function setup(page: Page) {
  await mockStressTimeline(page)
  await page.addInitScript(
    ({ directory, server, sessionIDs }) => {
      if (localStorage.getItem("opencode.window.browser.dat:tabs")) return
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, quietCompanion: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([
          ...sessionIDs.map((sessionId) => ({ type: "session", server, sessionId })),
          { type: "draft", draftID: "draft_cm3_list", server, directory },
        ]),
      )
    },
    {
      directory: fixture.directory,
      server: `http://127.0.0.1:${process.env.PLAYWRIGHT_SERVER_PORT}`,
      sessionIDs: [fixture.sourceID, fixture.targetID],
    },
  )
}

for (const viewport of [
  { width: 1280, direction: "ltr" },
  { width: 1280, direction: "rtl" },
  { width: 390, direction: "ltr" },
]) {
  test(`CM3 drafts preserve text across chat switching and reload at ${viewport.width}px ${viewport.direction}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: 800 })
    await setup(page)
    await page.goto("/new-session?draftId=draft_cm3_list")
    await expect(composer(page)).toBeEditable()
    await page.evaluate((direction) => document.documentElement.setAttribute("dir", direction), viewport.direction)
    await composer(page).fill("Plan the audit")
    await composer(page).press("Shift+Enter")
    await page.keyboard.insertText("Keep these details")
    if (viewport.width === 390) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
    await expect(draftRow(page, "Plan the audit").getByText("Draft", { exact: true })).toBeVisible()
    await expect(
      draftRow(page, "Plan the audit").getByRole("button", {
        name: `Plan the audit ${fixture.project.name} Draft`,
        exact: true,
      }),
    ).toHaveAttribute("aria-current", "page")
    await page.getByRole("button", { name: "New chat", exact: true }).click()
    await expect(composer(page)).toHaveText("")
    await composer(page).fill("Second draft")
    if (viewport.width === 390) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
    await draftRow(page, "Plan the audit")
      .getByRole("button", { name: `Plan the audit ${fixture.project.name} Draft`, exact: true })
      .click()
    await expect(composer(page)).toHaveText("Plan the audit\nKeep these details")
    await page.reload()
    await expect(composer(page)).toHaveText("Plan the audit\nKeep these details")
    if (viewport.width === 390) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
    await draftRow(page, "Second draft")
      .getByRole("button", { name: `Second draft ${fixture.project.name} Draft`, exact: true })
      .click()
    await expect(composer(page)).toHaveText("Second draft")
    if (viewport.width === 390) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
    await inbox(page).locator(`[data-session-id="${fixture.sourceID}"] [data-action="sidebar-session"]`).click()
    await expect(page).toHaveURL(stressSessionHref(fixture.sourceID))
    await expect(composer(page)).toBeEditable()
    if (viewport.width === 390) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
    await draftRow(page, "Plan the audit")
      .getByRole("button", { name: `Plan the audit ${fixture.project.name} Draft`, exact: true })
      .click()
    await expect(composer(page)).toHaveText("Plan the audit\nKeep these details")
    await expect(page.locator(".cm3-sidebar-tabs")).toHaveCount(0)
    await expect(page.locator("[data-titlebar-tab-slot]")).toHaveCount(4)
    await expect(page.getByRole("button", { name: "Dismiss Tabs information", exact: true })).toHaveCount(0)
  })
}

test("CM3 drafts can be searched and explicitly discarded without altering another draft", async ({ page }) => {
  await setup(page)
  await page.goto("/new-session?draftId=draft_cm3_list")
  await expect(composer(page)).toBeEditable()
  await composer(page).fill("Discard this draft")
  await expect(draftRow(page, "Discard this draft")).toBeVisible()
  await page.getByRole("button", { name: "New chat", exact: true }).click()
  await expect(composer(page)).toHaveText("")
  await composer(page).fill("Keep this draft")
  await expect(draftRow(page, "Keep this draft")).toBeVisible()
  const search = page.getByRole("searchbox", { name: "Search threads", exact: true })
  await search.fill("Discard this")
  const discard = draftRow(page, "Discard this draft")
  await expect(discard).toBeVisible()
  await expect(inbox(page).locator('[data-action="sidebar-session"]')).toHaveCount(0)
  await discard.hover()
  await discard.getByRole("button", { name: "More options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Discard draft", exact: true }).click()
  await expect(discard).toHaveCount(0)
  await expect(composer(page)).toHaveText("Keep this draft")
  await search.fill("")
  await expect(draftRow(page, "Keep this draft")).toBeVisible()
  await page.reload()
  await expect(composer(page)).toHaveText("Keep this draft")
  await expect(draftRow(page, "Discard this draft")).toHaveCount(0)
  const active = draftRow(page, "Keep this draft")
  await active.hover()
  await active.getByRole("button", { name: "More options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Discard draft", exact: true }).click()
  await expect(active).toHaveCount(0)
  await expect(page).not.toHaveURL(/draftId=/)
})

test("CM3 chats keep an older active session within five rows and reveal the full history", async ({ page }) => {
  await mockOpenCodeServer(page, {
    sessions: Array.from({ length: 72 }, (_, index) => ({
      ...fixture.sessions[0],
      id: index === 0 ? fixture.sourceID : `ses_cm3_history_${index}`,
      title: `Older chat ${index}`,
      time: { created: index + 1, updated: index + 1 },
    })),
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  await installStressSessionTabs(page, { sessionIDs: [fixture.sourceID] })
  await page.addInitScript(() =>
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, quietCompanion: true } })),
  )
  await page.goto(stressSessionHref(fixture.sourceID))
  const rows = inbox(page).locator('[data-action="sidebar-session"]')
  await expect(rows).toHaveCount(5)
  await expect(rows.locator(".cm3-sidebar-task-copy > span:first-child")).toHaveText([
    "Older chat 71",
    "Older chat 70",
    "Older chat 69",
    "Older chat 68",
    "Older chat 0",
  ])
  await expect(rows.filter({ hasText: "Older chat 0" })).toHaveAttribute("aria-current", "page")
  for (let count = 10; count <= 70; count += 5) {
    await inbox(page).getByRole("button", { name: "Show more", exact: true }).click()
    await expect(rows).toHaveCount(count)
  }
  await inbox(page).getByRole("button", { name: "Show more", exact: true }).click()
  await expect(rows).toHaveCount(72)
  await expect(inbox(page).getByRole("button", { name: "Show more", exact: true })).toHaveCount(0)
  await page.getByRole("searchbox", { name: "Search threads", exact: true }).fill("Older chat 1")
  await expect(rows).toHaveCount(5)
  await inbox(page).getByRole("button", { name: "Show more", exact: true }).click()
  await expect(rows).toHaveCount(10)
  await inbox(page).getByRole("button", { name: "Show more", exact: true }).click()
  await expect(rows).toHaveCount(11)
})

test("CM3 drafts share the five-row Inbox page with saved chats", async ({ page }) => {
  await setup(page)
  await page.goto("/new-session?draftId=draft_cm3_list")
  await expect(composer(page)).toBeEditable()
  await composer(page).fill("Draft 1")
  for (let index = 2; index <= 6; index++) {
    await page.getByRole("button", { name: "New chat", exact: true }).click()
    await expect(composer(page)).toHaveText("")
    await composer(page).fill(`Draft ${index}`)
  }
  const rows = inbox(page).getByRole("group")
  await expect(rows).toHaveCount(5)
  await expect(draftRow(page, "Draft 6")).toBeVisible()
  await inbox(page).getByRole("button", { name: "Show more", exact: true }).click()
  await expect(rows).toHaveCount(8)
  await expect(draftRow(page, "Draft 1")).toBeVisible()
  await expect(inbox(page).getByRole("button", { name: "Show more", exact: true })).toHaveCount(0)
})

test("CM3 drafts become one saved chat after submission", async ({ page }) => {
  await setup(page)
  await page.route(/\/session(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    return route.fulfill({ json: fixture.sessions[0] })
  })
  await page.route(/\/session\/[^/]+\/prompt_async(?:\?.*)?$/, (route) => route.fulfill({ status: 204 }))
  await page.goto("/new-session?draftId=draft_cm3_list")
  await expect(composer(page)).toBeEditable()
  await composer(page).fill("Submit this draft")
  await expect(draftRow(page, "Submit this draft")).toBeVisible()
  const admitted = page.waitForRequest(
    (request) =>
      request.method() === "POST" && new URL(request.url()).pathname === `/session/${fixture.sourceID}/prompt_async`,
  )
  await composer(page).press("Enter")
  await admitted
  await expect(page).toHaveURL(stressSessionHref(fixture.sourceID))
  await expect(inbox(page).locator('[data-draft-id="draft_cm3_list"]')).toHaveCount(0)
  await expect(inbox(page).locator(`[data-session-id="${fixture.sourceID}"]`)).toHaveCount(1)
})

test("CM3 drafts show their project labels and stay scoped to their server", async ({ page }) => {
  await setup(page)
  const remote = `http://cm3-drafts.test:${process.env.PLAYWRIGHT_SERVER_PORT}`
  await page.addInitScript(
    ({ directory, local, remote }) => {
      const projects = [
        { worktree: directory, expanded: true },
        { worktree: "C:/OpenCode/OtherProject", expanded: true },
      ]
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [{ type: "http", http: { url: remote }, displayName: "Remote drafts" }],
          projects: { local: projects, [remote]: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([
          { type: "draft", draftID: "draft_cm3_list", server: local, directory },
          { type: "draft", draftID: "draft_cm3_other", server: local, directory: "C:/OpenCode/OtherProject" },
          { type: "draft", draftID: "draft_cm3_remote", server: remote, directory },
        ]),
      )
    },
    { directory: fixture.directory, local: `http://127.0.0.1:${process.env.PLAYWRIGHT_SERVER_PORT}`, remote },
  )
  await page.goto("/new-session?draftId=draft_cm3_list")
  await expect(composer(page)).toBeEditable()
  await composer(page).fill("Local primary draft")
  const primary = inbox(page).locator('[data-draft-id="draft_cm3_list"]')
  const other = inbox(page).locator('[data-draft-id="draft_cm3_other"]')
  await expect(primary).toBeVisible()
  await expect(primary.getByText(fixture.project.name, { exact: true })).toBeVisible()
  await expect(other).toBeVisible()
  await expect(other.getByText("OtherProject", { exact: true })).toBeVisible()
  await expect(inbox(page).locator('[data-draft-id="draft_cm3_remote"]')).toHaveCount(0)
  await page.goto("/new-session?draftId=draft_cm3_remote")
  await expect(composer(page)).toBeEditable()
  await composer(page).fill("Remote draft")
  await expect(draftRow(page, "Remote draft")).toBeVisible()
  await expect(inbox(page).locator('[data-draft-id="draft_cm3_list"]')).toHaveCount(0)
  await expect(inbox(page).locator('[data-draft-id="draft_cm3_other"]')).toHaveCount(0)
})
