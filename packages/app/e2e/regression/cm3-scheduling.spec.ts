import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import type { ScheduleDefinition } from "../../src/utils/scheduling"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"
import {
  installStressSessionTabs,
  mockStressTimeline,
  stressSessionHref,
} from "../performance/timeline/timeline-test-helpers"

const definition: ScheduleDefinition = {
  schemaVersion: 1,
  name: "Daily project review",
  prompt: "Review recent changes and summarize anything needing attention.",
  enabled: true,
  execution: "while_app_running",
  target: { type: "new_session", directory: fixture.directory, workspace: { type: "local" } },
  schedule: { type: "calendar", weekdays: ["mon", "wed"], time: "09:00", timezone: "Africa/Johannesburg" },
  misfire: { type: "catch_up_once", withinMinutes: 60 },
  notification: "all_runs",
}

async function setup(page: Page, secondServer?: string) {
  await mockStressTimeline(page)
  if (!secondServer) await installStressSessionTabs(page, { draftID: "draft_scheduling" })
  await page.addInitScript(
    ({ second, first, directory, source, target, dirBase64 }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, quietCompanion: true } }))
      if (!second) return
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [second],
          projects: {
            local: [{ worktree: directory, expanded: true }],
            [second]: [{ worktree: directory, expanded: true }],
          },
          lastProject: { local: directory, [second]: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([
          { type: "session", server: first, sessionId: source, dirBase64 },
          { type: "session", server: second, sessionId: target, dirBase64 },
        ]),
      )
    },
    {
      second: secondServer,
      first: `http://127.0.0.1:${process.env.PLAYWRIGHT_SERVER_PORT}`,
      directory: fixture.directory,
      source: fixture.sourceID,
      target: fixture.targetID,
      dirBase64: base64Encode(fixture.directory),
    },
  )
  const state = {
    schedules: [
      {
        id: "schedule_review",
        revision: 1,
        definition,
        directory: fixture.directory,
        next: Date.now() + 3600000,
        runs: 1,
        deleted: false,
      },
    ],
    occurrences: [
      {
        id: "run_review",
        scheduleID: "schedule_review",
        at: Date.now() - 3600000,
        definition,
        sessionID: fixture.sourceID,
        directory: fixture.directory,
        admitted: true,
        state: "attention",
        detail: "Review the result",
      },
    ],
    totalOccurrences: 1,
  }
  const requests: { action: string; id?: string; definition?: ScheduleDefinition }[] = []
  const faults = { read: false, write: false, reads: 0 }
  await page.route("**/schedule", async (route) => {
    if (route.request().method() === "GET") {
      faults.reads += 1
      return route.fulfill({
        status: faults.read ? 503 : 200,
        json: faults.read ? { message: "Temporarily unavailable" } : state,
      })
    }
    const body = route.request().postDataJSON()
    requests.push(body)
    if (faults.write) return route.fulfill({ status: 500, json: { message: "Save failed" } })
    const task = state.schedules.find((item) => item.id === body.id)
    if (body.action === "pause" && task) task.definition = { ...task.definition, enabled: false }
    if (body.action === "resume" && task) task.definition = { ...task.definition, enabled: true }
    if (body.action === "update" && task) task.definition = body.definition
    if (body.action === "create")
      state.schedules.push({ ...state.schedules[0], id: "schedule_new", definition: body.definition })
    if (body.action === "delete" && task) task.deleted = true
    if (body.action === "acknowledge") state.occurrences[0].state = "skipped"
    return route.fulfill({ json: true })
  })
  return { state, requests, faults }
}

const panel = (page: Page) => page.locator('[data-component="scheduling-panel"]')
const open = (page: Page) =>
  page.locator(".cm3-sidebar").getByRole("button", { name: "Scheduled", exact: true }).click()

test("the scheduling deep link opens the panel on CM3 home", async ({ page }) => {
  await setup(page)
  await page.goto("/scheduled")
  await expect(page).toHaveURL("/")
  await expect(panel(page)).toBeVisible()
  await expect(panel(page).getByText(definition.name, { exact: true })).toBeVisible()
  await expect(page.locator(".scheduled-page")).toHaveCount(0)
})

test("Scheduling preserves the conversation, composer and prior review panel", async ({ page }) => {
  await setup(page)
  await page.goto(stressSessionHref(fixture.sourceID))
  const composer = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  await expect(composer).toBeEditable()
  await composer.fill("Keep this unsent conversation draft")
  const original = await composer.elementHandle()
  await page.getByRole("button", { name: "Toggle review", exact: true }).click()
  const review = page.locator("#review-panel")
  await expect(review).toHaveAttribute("aria-hidden", "false")
  const originalReview = await review.elementHandle()
  const url = page.url()
  await open(page)
  await expect(panel(page)).toBeVisible()
  await expect(page).toHaveURL(url)
  await expect(composer).toHaveText("Keep this unsent conversation draft")
  await expect(review).toHaveAttribute("aria-hidden", "true")
  expect((await panel(page).boundingBox())?.width).toBe(420)
  await page.screenshot({ path: test.info().outputPath("scheduling-panel.png") })
  await panel(page).getByRole("button", { name: /close/i }).click()
  await expect(panel(page)).toBeHidden()
  await expect(page.locator('[data-action="scheduling"]')).toBeFocused()
  await expect(review).toHaveAttribute("aria-hidden", "false")
  expect(await review.evaluate((element, original) => element === original, originalReview)).toBe(true)
  expect(await composer.evaluate((element, original) => element === original, original)).toBe(true)
})

test("inline task drafts survive closing and saving uses the existing schedule API", async ({ page }) => {
  const api = await setup(page)
  await page.goto("/new-session?draftId=draft_scheduling")
  await open(page)
  await panel(page).getByRole("button", { name: "New task", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await panel(page).getByLabel("Name", { exact: true }).fill("Morning review")
  await panel(page).getByLabel("Instructions", { exact: true }).fill("Review my project each morning.")
  await panel(page).getByRole("button", { name: /close/i }).click()
  await open(page)
  await expect(panel(page).getByLabel("Name", { exact: true })).toHaveValue("Morning review")
  api.faults.write = true
  await panel(page).getByRole("button", { name: "Save task", exact: true }).click()
  await expect(panel(page).getByRole("alert")).toContainText("Save failed")
  await expect(panel(page).getByLabel("Name", { exact: true })).toHaveValue("Morning review")
  api.faults.write = false
  await panel(page).getByRole("button", { name: "Save task", exact: true }).click()
  await expect(panel(page).getByText("Morning review", { exact: true })).toBeVisible()
  const saved = api.requests.findLast((item) => item.action === "create")?.definition
  expect(saved?.target).toEqual({ type: "new_session", directory: fixture.directory, workspace: { type: "local" } })
  expect(saved?.prompt).toBe("Review my project each morning.")
  expect(saved?.execution).toBe("while_app_running")
})

test("task details, pause/resume, run review and conversation links remain in the panel", async ({ page }) => {
  const api = await setup(page)
  await page.goto("/")
  await open(page)
  await panel(page)
    .getByRole("button", { name: /Daily project review/ })
    .click()
  await expect(panel(page)).toContainText(definition.prompt)
  await panel(page).getByRole("button", { name: "Pause", exact: true }).click()
  await expect(panel(page).getByRole("button", { name: "Resume", exact: true })).toBeVisible()
  await panel(page).getByRole("button", { name: "Resume", exact: true }).click()
  await expect(panel(page).getByRole("button", { name: "Pause", exact: true })).toBeVisible()
  await panel(page).getByRole("button", { name: "Mark reviewed", exact: true }).click()
  expect(api.requests.map((item) => item.action)).toEqual(["pause", "resume", "acknowledge"])
  await panel(page).getByRole("button", { name: "Open conversation", exact: true }).click()
  await expect(page).toHaveURL(stressSessionHref(fixture.sourceID))
})

test("cached tasks survive a failed refresh and polling stops when closed", async ({ page }) => {
  const api = await setup(page)
  await page.clock.install()
  await page.goto("/")
  await open(page)
  await expect(panel(page).getByText(definition.name, { exact: true })).toBeVisible()
  api.faults.read = true
  await panel(page).getByRole("button", { name: "Refresh scheduled tasks", exact: true }).click()
  await expect(panel(page).getByRole("alert")).toBeVisible()
  await expect(panel(page).getByText(definition.name, { exact: true })).toBeVisible()
  api.faults.read = false
  await panel(page).getByRole("button", { name: "Try again", exact: true }).click()
  await expect(panel(page).getByRole("alert")).toHaveCount(0)
  await panel(page).getByRole("button", { name: /close/i }).click()
  const reads = api.faults.reads
  await page.clock.fastForward(30000)
  expect(api.faults.reads).toBe(reads)
  await open(page)
  await expect.poll(() => api.faults.reads).toBeGreaterThan(reads)
})

test("the command palette opens Scheduling without navigating away", async ({ page }) => {
  await setup(page)
  await page.goto("/new-session?draftId=draft_scheduling")
  const composer = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  await expect(composer).toBeEditable()
  await composer.fill("Keep my palette draft")
  const url = page.url()
  await page.keyboard.press("Control+Shift+P")
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await dialog.getByRole("textbox").fill("Scheduled")
  await expect(dialog.getByText("Scheduled", { exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("command-palette.png") })
  await page.keyboard.press("Enter")
  await expect(panel(page)).toBeVisible()
  await expect(page).toHaveURL(url)
  await expect(composer).toHaveText("Keep my palette draft")
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('[data-component="dialog-stack"]')).toBeEmpty()
  await expect(panel(page).getByRole("heading", { name: "Scheduling", exact: true })).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(panel(page)).toBeHidden()
})

test("dirty edits require explicit discard and deletion requires confirmation", async ({ page }) => {
  const api = await setup(page)
  await page.goto("/")
  await open(page)
  await panel(page)
    .getByRole("button", { name: /Daily project review/ })
    .click()
  await panel(page).getByRole("button", { name: "Edit", exact: true }).click()
  await panel(page).getByLabel("Name", { exact: true }).fill("Unsaved rename")
  await panel(page).getByRole("button", { name: "Cancel", exact: true }).click()
  const confirmation = panel(page).getByRole("alertdialog")
  await expect(confirmation).toContainText("Discard your unsaved")
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(panel(page).getByLabel("Name", { exact: true })).toHaveValue("Unsaved rename")
  await panel(page).getByRole("button", { name: "Cancel", exact: true }).click()
  await confirmation.getByRole("button", { name: "Discard changes", exact: true }).click()
  await expect(panel(page).getByLabel("Name", { exact: true })).toHaveCount(0)
  await panel(page).getByRole("button", { name: "Delete", exact: true }).click()
  expect(api.requests).toHaveLength(0)
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click()
  await expect(panel(page).getByText("A little less busywork", { exact: true })).toBeVisible()
  expect(api.requests).toEqual([{ action: "delete", id: "schedule_review" }])
})

test("editing preserves exact timing, model variant and unexposed definition fields", async ({ page }) => {
  const api = await setup(page)
  api.state.schedules[0].definition = {
    ...definition,
    schedule: { type: "interval", everyMinutes: 90, startsAt: "2026-11-01T06:31:42.123Z" },
    target: {
      type: "new_session",
      directory: fixture.directory,
      workspace: { type: "worktree", baseRef: "release" },
      model: { providerID: "unavailable", id: "saved-model", variant: "high" },
    },
    maxRuns: 5,
    endsAt: "2026-12-01T00:00:00.000Z",
    misfire: { type: "skip" },
    enabled: false,
  }
  const original = api.state.schedules[0].definition
  await page.goto("/")
  await open(page)
  await panel(page)
    .getByRole("button", { name: /Daily project review/ })
    .click()
  await panel(page).getByRole("button", { name: "Edit", exact: true }).click()
  await panel(page).getByLabel("Name", { exact: true }).fill("Renamed task")
  await panel(page).getByRole("button", { name: "Save task", exact: true }).click()
  await expect(panel(page).getByText("Renamed task", { exact: true })).toBeVisible()
  expect(api.requests[0]).toEqual({
    action: "update",
    id: "schedule_review",
    definition: { ...original, name: "Renamed task" },
  })
})

test("server changes ignore stale reads and retain drafts under their original server", async ({ page }) => {
  const second = `http://localhost:${process.env.PLAYWRIGHT_SERVER_PORT}`
  const api = await setup(page, second)
  const secondHref = `/server/${base64Encode(second)}/session/${fixture.targetID}`
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const requests = { pending: false, second: 0 }
  await page.route("**/schedule", async (route) => {
    if (new URL(route.request().url()).hostname === "localhost") {
      requests.second += 1
      return route.fulfill({ json: { schedules: [], occurrences: [], totalOccurrences: 0 } })
    }
    if (!requests.pending) return route.fallback()
    await gate
    await route.fulfill({ json: api.state }).catch(() => undefined)
  })
  await page.goto(stressSessionHref(fixture.sourceID))
  await open(page)
  await expect(panel(page).getByText(definition.name, { exact: true })).toBeVisible()
  requests.pending = true
  await panel(page).getByRole("button", { name: "Refresh scheduled tasks", exact: true }).click()
  await panel(page).getByRole("button", { name: "New task", exact: true }).click()
  await panel(page).getByLabel("Name", { exact: true }).fill("First server draft")
  await page.keyboard.press("Control+2")
  await expect(page).toHaveURL(secondHref)
  await expect.poll(() => requests.second).toBeGreaterThan(0)
  release?.()
  await expect(panel(page).getByText("A little less busywork", { exact: true })).toBeVisible()
  await expect(panel(page).getByText(definition.name, { exact: true })).toHaveCount(0)
  requests.pending = false
  await page.keyboard.press("Control+1")
  await expect(page).toHaveURL(stressSessionHref(fixture.sourceID))
  await expect(panel(page).getByLabel("Name", { exact: true })).toHaveValue("First server draft")
})
