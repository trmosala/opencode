import { expect, test, type Page } from "@playwright/test"
import type { Event } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer, type MockServerConfig } from "../utils/mock-server"
import { fixture, pageMessages } from "../performance/timeline/session-timeline-stress.fixture"
import { installTimelineSettings, stressSessionHref } from "../performance/timeline/timeline-test-helpers"

const rows = (page: Page) => page.locator(".cm3-sidebar-workflow")
const row = (page: Page, id: string) => rows(page).locator(`[data-session-id="${id}"]`)
const pane = (page: Page, side: string) => page.locator(`[data-chat-pane="${side}"]`)
const editor = (page: Page, side: string) =>
  pane(page, side).locator('[data-component="prompt-input"][contenteditable="true"]')

async function setup(
  page: Page,
  options?: Pick<
    MockServerConfig,
    "events" | "sessionStatus" | "fileList" | "fileContent" | "sessions" | "pageMessages" | "beforeMessagesResponse"
  >,
) {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await mockOpenCodeServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
    ...options,
  })
  await page.addInitScript(
    ({ directory, server, ids }) => {
      if (localStorage.getItem("opencode.window.browser.dat:tabs")) return
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify(ids.map((sessionId) => ({ type: "session", server, sessionId }))),
      )
    },
    {
      directory: fixture.directory,
      server: `http://127.0.0.1:${process.env.PLAYWRIGHT_SERVER_PORT}`,
      ids: [fixture.sourceID, fixture.targetID],
    },
  )
  await installTimelineSettings(page, true)
  await page.goto(stressSessionHref(fixture.sourceID))
  await expect(editor(page, "primary")).toBeEditable()
  if (!options?.sessionStatus) await expect(row(page, fixture.targetID)).toBeVisible()
}

async function organize(page: Page, id: string, action: string) {
  await row(page, id).hover()
  await row(page, id).getByRole("button", { name: "More options", exact: true }).click()
  await page.getByRole("menuitem", { name: action, exact: true }).click()
}

test("workflow sections persist and keep the selected chat visible when collapsed", async ({ page }) => {
  await setup(page)
  const section = (name: string) => rows(page).locator(`[data-workflow="${name}"]`)
  await expect(section("inbox").locator(`[data-session-id="${fixture.targetID}"]`)).toBeVisible()
  await organize(page, fixture.targetID, "Settle")
  await expect(row(page, fixture.targetID)).toHaveCount(0)
  await section("settled").getByRole("button", { name: "Settled", exact: true }).click()
  await expect(row(page, fixture.targetID)).toBeVisible()
  await page.reload()
  await expect(editor(page, "primary")).toBeEditable()
  await expect(row(page, fixture.targetID)).toBeVisible()
  await organize(page, fixture.targetID, "Move to Inbox")
  await expect(section("inbox").locator(`[data-session-id="${fixture.targetID}"]`)).toBeVisible()
  await organize(page, fixture.sourceID, "Settle")
  await section("settled").getByRole("button", { name: "Settled", exact: true }).click()
  await expect(section("settled").locator(`[data-session-id="${fixture.sourceID}"]`)).toBeVisible()
  await page.reload()
  await expect(section("settled").getByRole("button", { name: "Settled", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  )
  await expect(row(page, fixture.sourceID)).toBeVisible()
  await page.clock.install()
  await organize(page, fixture.targetID, "Snooze for 1 hour")
  await expect(row(page, fixture.targetID)).toHaveCount(0)
  await section("snoozed").getByRole("button", { name: "Snoozed", exact: true }).click()
  await expect(row(page, fixture.targetID)).toBeVisible()
  await page.clock.fastForward(60 * 60 * 1000 + 1000)
  await expect(section("inbox").locator(`[data-session-id="${fixture.targetID}"]`)).toBeVisible()
})

test("split chats keep drafts, navigation and submission separate and restore after reload", async ({ page }) => {
  await setup(page)
  await editor(page, "primary").fill("Keep the left draft")
  await organize(page, fixture.targetID, "Open in split view")
  await expect(pane(page, "secondary").getByRole("heading", { name: fixture.expected.targetTitle })).toBeVisible()
  await expect(editor(page, "secondary")).toBeEditable()
  await editor(page, "secondary").fill("Only send this on the right")
  await editor(page, "secondary").press("Control+Shift+r")
  await expect(pane(page, "secondary").locator("#review-panel")).toBeVisible()
  await expect(pane(page, "primary").locator("#review-panel")).toHaveCount(0)
  await editor(page, "secondary").press("Control+Shift+r")
  await expect(editor(page, "primary")).toHaveText("Keep the left draft")
  await page.reload()
  await expect(editor(page, "primary")).toHaveText("Keep the left draft")
  await expect(editor(page, "secondary")).toHaveText("Only send this on the right")
  await page.route(/\/session\/[^/]+\/prompt_async(?:\?.*)?$/, (route) => route.fulfill({ status: 204 }))
  const sent = page.waitForRequest(
    (request) =>
      request.method() === "POST" && new URL(request.url()).pathname === `/session/${fixture.targetID}/prompt_async`,
  )
  await editor(page, "secondary").press("Enter")
  const request = await sent
  expect(request.postData()).toContain("Only send this on the right")
  expect(request.postData()).not.toContain("Keep the left draft")
  await expect(editor(page, "primary")).toHaveText("Keep the left draft")
  await expect(page).toHaveURL(stressSessionHref(fixture.sourceID))
  const divider = page.getByRole("separator", { name: "Resize chats" })
  await divider.press("ArrowRight")
  await expect(divider).toHaveAttribute("aria-valuenow", "55")
  await page.getByRole("button", { name: "Close split", exact: true }).click()
  await expect(pane(page, "secondary")).toHaveCount(0)
  await expect(editor(page, "primary")).toHaveText("Keep the left draft")
})

test("dragging a sidebar chat over the composer splits without navigating the left", async ({ page }) => {
  await setup(page)
  const chat = row(page, fixture.targetID).locator('[data-action="sidebar-session"]')
  const composer = editor(page, "primary")
  const bounds = await composer.boundingBox()
  if (!bounds) throw new Error("Missing chat composer")
  await chat.dragTo(composer, { targetPosition: { x: bounds.width - 20, y: bounds.height / 2 } })
  await expect(pane(page, "secondary").getByRole("heading", { name: fixture.expected.targetTitle })).toBeVisible()
  await expect(pane(page, "primary").getByRole("heading", { name: fixture.expected.sourceTitle })).toBeVisible()
  await expect(page.getByText("Drop files to attach", { exact: true })).toHaveCount(0)
  await editor(page, "primary").fill("The left draft is still usable")
  await page.setViewportSize({ width: 600, height: 900 })
  await expect(pane(page, "secondary")).toHaveCount(0)
  await expect(editor(page, "primary")).toBeEditable()
  await page.setViewportSize({ width: 1600, height: 1000 })
  await expect(pane(page, "secondary").getByRole("heading", { name: fixture.expected.targetTitle })).toBeVisible()
})

test("dragging an open tab out of the tab strip creates a split", async ({ page }, testInfo) => {
  await setup(page)
  const tab = page
    .locator("[data-titlebar-tab-slot]")
    .filter({ has: page.locator(`a[href="${stressSessionHref(fixture.targetID)}"]`) })
  const from = await tab.boundingBox()
  const to = await page.locator(".cm-chat-workspace").boundingBox()
  if (!from || !to) throw new Error("Missing drag source or workspace")
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width - 60, to.y + 180, { steps: 20 })
  await expect(page.locator('.cm-chat-drop[data-over="true"]')).toBeVisible()
  await page.mouse.up()
  await expect(pane(page, "secondary").getByRole("heading", { name: fixture.expected.targetTitle })).toBeVisible()
  await expect(pane(page, "primary").getByRole("heading", { name: fixture.expected.sourceTitle })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("split.png") })
})

test("new chats and closing tabs target the focused split pane", async ({ page }) => {
  await setup(page)
  await editor(page, "primary").fill("Left stays here")
  await organize(page, fixture.targetID, "Open in split view")
  await editor(page, "secondary").click()
  await page.getByRole("button", { name: "New chat", exact: true }).click()
  // The target composer is also empty and stays mounted until the draft route commits; wait for it to leave.
  await expect(pane(page, "secondary").getByRole("heading", { name: fixture.expected.targetTitle })).toHaveCount(0)
  await expect(editor(page, "secondary")).toHaveText("")
  await editor(page, "secondary").fill("New right draft")
  await expect(editor(page, "primary")).toHaveText("Left stays here")
  await row(page, fixture.targetID).locator('[data-action="sidebar-session"]').click()
  await expect(pane(page, "secondary").getByRole("heading", { name: fixture.expected.targetTitle })).toBeVisible()
  await expect(editor(page, "primary")).toHaveText("Left stays here")
  const tab = page
    .locator("[data-titlebar-tab-slot]")
    .filter({ has: page.locator(`a[href="${stressSessionHref(fixture.targetID)}"]`) })
  await tab.getByRole("button", { name: "Close tab", exact: true }).click()
  await expect(pane(page, "secondary")).toHaveCount(0)
  await expect(editor(page, "primary")).toHaveText("Left stays here")
  await organize(page, fixture.targetID, "Open in split view")
  await expect(editor(page, "secondary")).toBeEditable()
  const primaryTab = page
    .locator("[data-titlebar-tab-slot]")
    .filter({ has: page.locator(`a[href="${stressSessionHref(fixture.sourceID)}"]`) })
  await primaryTab.getByRole("button", { name: "Close tab", exact: true }).click()
  await expect(editor(page, "primary")).toHaveText("New right draft")
  await expect(pane(page, "secondary").getByRole("heading", { name: fixture.expected.targetTitle })).toBeVisible()
})

test("running chats are separate, cannot settle, and return to Inbox after the grace period", async ({ page }) => {
  const events: Event[] = []
  let busy = true
  await setup(page, {
    sessionStatus: () => (busy ? { [fixture.targetID]: { type: "busy" } } : {}),
    events: () => events.splice(0).map((payload) => ({ directory: fixture.directory, payload })),
  })
  await rows(page).locator('[data-workflow="working"] > button').click()
  await expect(
    rows(page).locator('[data-workflow="working"]').locator(`[data-session-id="${fixture.targetID}"]`),
  ).toBeVisible()
  await row(page, fixture.targetID).hover()
  await row(page, fixture.targetID).getByRole("button", { name: "More options", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "Settle", exact: true })).toHaveAttribute("aria-disabled", "true")
  await page.keyboard.press("Escape")
  busy = false
  events.push({
    id: "evt_idle",
    type: "session.status",
    properties: { sessionID: fixture.targetID, status: { type: "idle" } },
  })
  await expect(row(page, fixture.targetID).locator('[data-action="sidebar-session"]')).not.toHaveAttribute(
    "aria-description",
    "Running",
  )
  await expect(
    rows(page).locator('[data-workflow="working"]').locator(`[data-session-id="${fixture.targetID}"]`),
  ).toBeVisible()
  await expect(
    rows(page).locator('[data-workflow="inbox"]').locator(`[data-session-id="${fixture.targetID}"]`),
  ).toBeVisible()
})

for (const attention of ["question", "permission", "error", "prompt"] as const) {
  test(`snoozed chat wakes for ${attention} and stays awake after attention clears`, async ({ page }) => {
    const events: Event[] = []
    await setup(page, { events: () => events.splice(0).map((payload) => ({ directory: fixture.directory, payload })) })
    await organize(page, fixture.targetID, "Snooze for 1 hour")
    const sessionID = fixture.targetID
    // Snoozing awaits a history read; prove it applied before attention arrives, or the wake is never exercised.
    await expect(rows(page).locator('[data-workflow="inbox"]').locator(`[data-session-id="${sessionID}"]`)).toHaveCount(
      0,
    )
    if (attention === "question")
      events.push({
        id: "evt_question",
        type: "question.asked",
        properties: {
          id: "question_workflow",
          sessionID,
          questions: [
            { header: "Choice", question: "Continue?", options: [{ label: "Yes", description: "Continue" }] },
          ],
        },
      })
    if (attention === "permission")
      events.push({
        id: "evt_permission",
        type: "permission.asked",
        properties: {
          id: "permission_workflow",
          sessionID,
          permission: "read",
          patterns: ["test.txt"],
          always: [],
          metadata: {},
        },
      })
    if (attention === "error")
      events.push({
        id: "evt_error",
        type: "session.error",
        properties: {
          sessionID,
          error: { name: "UnknownError", data: { message: "Workflow test error" } },
        },
      })
    if (attention === "prompt")
      events.push({
        id: "evt_prompt",
        type: "message.updated",
        properties: {
          sessionID,
          info: {
            id: "msg_workflow_prompt",
            sessionID,
            role: "user",
            time: { created: Date.now() + 1 },
            agent: "build",
            model: { providerID: "test", modelID: "test" },
          },
        },
      })
    await expect(
      rows(page).locator('[data-workflow="inbox"]').locator(`[data-session-id="${sessionID}"]`),
    ).toBeVisible()
    if (attention === "question")
      events.push({
        id: "evt_question_clear",
        type: "question.rejected",
        properties: { sessionID, requestID: "question_workflow" },
      })
    if (attention === "permission")
      events.push({
        id: "evt_permission_clear",
        type: "permission.replied",
        properties: { sessionID, requestID: "permission_workflow", reply: "reject" },
      })
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            Object.values(JSON.parse(localStorage.getItem("opencode.global.dat:server")!).sessionWorkflow).filter(
              Boolean,
            ).length,
        ),
      )
      .toBe(0)
  })
}

test("settled chat ignores metadata changes and search reveals collapsed states", async ({ page }) => {
  const events: Event[] = []
  await setup(page, { events: () => events.splice(0).map((payload) => ({ directory: fixture.directory, payload })) })
  await organize(page, fixture.targetID, "Settle")
  const session = fixture.sessions.find((session) => session.id === fixture.targetID)!
  events.push({
    id: "evt_rename",
    type: "session.updated",
    properties: {
      sessionID: session.id,
      info: { ...session, title: "Renamed settled chat", time: { ...session.time, updated: Date.now() } },
    },
  })
  await page.getByRole("searchbox", { name: "Search threads", exact: true }).fill("Renamed settled chat")
  await expect(
    rows(page).locator('[data-workflow="settled"]').locator(`[data-session-id="${fixture.targetID}"]`),
  ).toBeVisible()
  await page.getByRole("searchbox", { name: "Search threads", exact: true }).fill("")
  await expect(row(page, fixture.targetID)).toHaveCount(0)
})

test("file drops attach only to the pane under the drop", async ({ page }) => {
  await setup(page)
  await organize(page, fixture.targetID, "Open in split view")
  await expect(editor(page, "secondary")).toBeEditable()
  for (const side of ["secondary", "primary"]) {
    await pane(page, side)
      .getByRole("heading")
      .first()
      .evaluate((target, side) => {
        const dataTransfer = new DataTransfer()
        dataTransfer.items.add(new File(["Only this pane"], `${side}.txt`, { type: "text/plain" }))
        target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }))
      }, side)
    await expect(pane(page, side).getByText(`${side}.txt`, { exact: true })).toBeVisible()
    await expect(
      pane(page, side === "primary" ? "secondary" : "primary").getByText(`${side}.txt`, { exact: true }),
    ).toHaveCount(0)
  }
})

test("Home toggles in the focused secondary pane", async ({ page }) => {
  await setup(page)
  await organize(page, fixture.targetID, "Open in split view")
  await editor(page, "secondary").fill("Right draft survives Home")
  await editor(page, "secondary").press("Control+b")
  await expect(pane(page, "secondary").getByRole("heading", { name: fixture.expected.targetTitle })).toHaveCount(0)
  await expect(pane(page, "primary").getByRole("heading", { name: fixture.expected.sourceTitle })).toBeVisible()
  await page.keyboard.press("Control+b")
  await expect(editor(page, "secondary")).toHaveText("Right draft survives Home")
  await expect(page).toHaveURL(stressSessionHref(fixture.sourceID))
})

test("pending settlement survives reload while run status is loading", async ({ page }) => {
  const events: Event[] = []
  await setup(page, {
    sessionStatus: { [fixture.targetID]: { type: "busy" } },
    events: () => events.splice(0).map((payload) => ({ directory: fixture.directory, payload })),
  })
  await rows(page).locator('[data-workflow="working"] > button').click()
  await expect(row(page, fixture.targetID).locator('[data-action="sidebar-session"]')).toHaveAttribute(
    "aria-description",
    "Running",
  )
  await page.evaluate(
    ({ id, server }) => {
      const key = "opencode.global.dat:server"
      const state = JSON.parse(localStorage.getItem(key)!)
      state.sessionWorkflow = {
        [JSON.stringify(["local", id])]: {
          state: "settled",
          pending: true,
          at: Date.now(),
          updated: Date.now() - 60_000,
        },
      }
      localStorage.setItem(key, JSON.stringify(state))
    },
    { id: fixture.targetID, server: process.env.PLAYWRIGHT_SERVER_PORT },
  )
  let release!: () => void
  const status = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(/\/session\/status(?:\?.*)?$/, async (route) => {
    await status
    await route.fulfill({ json: { [fixture.targetID]: { type: "busy" } } })
  })
  await page.reload()
  await expect(editor(page, "primary")).toBeEditable()
  await expect(row(page, fixture.targetID).getByText("Settles after run", { exact: true })).toBeVisible()
  const loaded = page.waitForResponse(/\/session\/status(?:\?.*)?$/)
  release()
  await (await loaded).finished()
  await expect(row(page, fixture.targetID).getByText("Settles after run", { exact: true })).toBeVisible()
  events.push({
    id: "evt_reloaded_idle",
    type: "session.status",
    properties: { sessionID: fixture.targetID, status: { type: "idle" } },
  })
  await expect(row(page, fixture.targetID)).toHaveCount(0)
})

test("file search follows the focused pane when both have file tabs", async ({ page }) => {
  await setup(page, {
    fileList: () => [
      {
        name: "split.txt",
        path: "split.txt",
        absolute: `${fixture.directory}/split.txt`,
        type: "file",
        ignored: false,
      },
    ],
    fileContent: () => ({ type: "text", content: "Search this pane" }),
  })
  await page.setViewportSize({ width: 2400, height: 1200 })
  await organize(page, fixture.targetID, "Open in split view")
  for (const side of ["primary", "secondary"]) {
    await editor(page, side).press("Control+Shift+r")
    await pane(page, side)
      .locator(".session-side-panel-tabs")
      .getByRole("button", { name: "New tab", exact: true })
      .click()
    await pane(page, side).locator("#review-panel").getByRole("button", { name: "Open file", exact: true }).click()
    await pane(page, side).getByRole("button", { name: "split.txt", exact: true }).click()
    await expect(pane(page, side).getByText("Search this pane", { exact: true })).toBeVisible()
  }
  for (const side of ["primary", "secondary", "primary"]) {
    await editor(page, side).click()
    await page.keyboard.press("Control+f")
    const search = page.locator('input[placeholder="Find"]:focus')
    await expect(search).toBeVisible()
    const bounds = await pane(page, side).boundingBox()
    const input = await search.boundingBox()
    if (!bounds || !input) throw new Error("Missing pane or file search")
    expect(input.x).toBeGreaterThanOrEqual(bounds.x)
    expect(input.x + input.width).toBeLessThanOrEqual(bounds.x + bounds.width)
  }
})

test("split permission preferences belong to each server", async ({ page }) => {
  await setup(page)
  const remote = `http://split-permissions.test:${process.env.PLAYWRIGHT_SERVER_PORT}`
  await page.evaluate(
    ({ remote, href }) => {
      const key = "opencode.global.dat:server"
      const state = JSON.parse(localStorage.getItem(key)!)
      state.list = [{ type: "http", http: { url: remote }, displayName: "Remote permissions" }]
      localStorage.setItem(key, JSON.stringify(state))
      localStorage.setItem("opencode.window.browser.dat:chat-split", JSON.stringify({ href, fraction: 0.5 }))
    },
    { remote, href: `/server/${base64Encode(remote)}/session/${fixture.sourceID}` },
  )
  await page.reload()
  await expect(editor(page, "primary")).toBeEditable()
  await expect(editor(page, "secondary")).toBeEditable()
  const left = pane(page, "primary").getByRole("switch", { name: "Auto-accept permissions" })
  const right = pane(page, "secondary").getByRole("switch", { name: "Auto-accept permissions" })
  await expect(left).not.toBeChecked()
  await expect(right).not.toBeChecked()
  await right.click()
  await expect(right).toBeChecked()
  await expect(left).not.toBeChecked()
  await page.reload()
  await expect(right).toBeChecked()
  await expect(left).not.toBeChecked()
})

for (const state of ["snoozed", "settled", "pending", "recovered"] as const) {
  test(`reload reconciles the third chat's newer prompt before retaining ${state}`, async ({ page }) => {
    const id = "ses_workflow_third"
    const now = Date.now()
    const oldPrompt = now - 60_000
    const newPrompt = now - 30_000
    const events: Event[] = []
    let failed = 0
    let recover = false
    let hold = false
    let requested = false
    let release!: () => void
    const history = new Promise<void>((resolve) => {
      release = resolve
    })
    await setup(page, {
      events: () => events.splice(0).map((payload) => ({ directory: fixture.directory, payload })),
      sessions: [
        ...fixture.sessions.map((session) => ({ ...session, time: { ...session.time, updated: now } })),
        {
          ...fixture.sessions[0],
          id,
          title: "Third workflow chat",
          time: { created: oldPrompt, updated: newPrompt + 1 },
        },
      ],
      pageMessages: (sessionID, limit, before) =>
        sessionID !== id
          ? pageMessages(sessionID, limit, before)
          : {
              items: [
                {
                  info: {
                    id: "msg_third_new",
                    sessionID: id,
                    role: "user",
                    time: { created: newPrompt },
                    agent: "build",
                    model: { providerID: "test", modelID: "test" },
                  },
                  parts: [],
                },
              ],
            },
      beforeMessagesResponse: async ({ sessionID }) => {
        if (sessionID !== id || !hold) return
        requested = true
        await history
      },
    })
    await page.evaluate(
      ({ id, state, oldPrompt, now }) => {
        const key = "opencode.global.dat:server"
        const store = JSON.parse(localStorage.getItem(key)!)
        store.sessionWorkflow = {
          [JSON.stringify(["local", id])]: {
            state: state === "pending" || state === "recovered" ? "settled" : state,
            updated: oldPrompt,
            ...(state === "pending" ? { pending: true } : { prompt: oldPrompt }),
            at: now - 5_000,
            until: now + 60_000,
          },
        }
        localStorage.setItem(key, JSON.stringify(store))
      },
      { id, state, oldPrompt, now },
    )
    if (state === "recovered")
      await page.route(new RegExp(`/session/${id}/messages?(?:\\?.*)?$`), async (route) => {
        if (recover) return route.fallback()
        failed++
        await route.fulfill({ status: 500, json: { message: "Temporary history failure" } })
      })
    hold = state !== "recovered"
    await page.reload()
    await expect(editor(page, "primary")).toBeEditable()
    if (state === "recovered") {
      await expect.poll(() => failed).toBeGreaterThan(0)
      await rows(page).locator('[data-workflow="settled"] > button').click()
      await expect(row(page, id)).toBeVisible()
      recover = true
      events.push({
        id: "evt_history_recovered",
        type: "session.updated",
        properties: {
          sessionID: id,
          info: {
            ...fixture.sessions[0],
            id,
            title: "Recovered workflow chat",
            time: { created: oldPrompt, updated: newPrompt + 2 },
          },
        },
      })
    }
    if (state !== "recovered") await expect.poll(() => requested).toBe(true)
    if (state === "pending")
      await expect
        .poll(() =>
          page.evaluate(
            (id) =>
              JSON.parse(localStorage.getItem("opencode.global.dat:server")!).sessionWorkflow[
                JSON.stringify(["local", id])
              ]?.pending,
            id,
          ),
        )
        .toBe(true)
    release()
    await expect(rows(page).locator('[data-workflow="inbox"]').locator(`[data-session-id="${id}"]`)).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            JSON.parse(localStorage.getItem("opencode.global.dat:server")!).sessionWorkflow[
              JSON.stringify(["local", id])
            ] ?? null,
          id,
        ),
      )
      .toBeNull()
  })
}

test("unpin reveals a collapsed Inbox and preserves keyboard focus", async ({ page }) => {
  await setup(page)
  await row(page, fixture.targetID).hover()
  await row(page, fixture.targetID).getByRole("button", { name: "Pin session", exact: true }).click()
  await rows(page).locator('[data-workflow="inbox"] > button').click()
  await row(page, fixture.targetID).getByRole("button", { name: "Unpin session", exact: true }).press("Enter")
  await expect(rows(page).locator('[data-workflow="inbox"] > button')).toHaveAttribute("aria-expanded", "true")
  await expect(row(page, fixture.targetID).getByRole("button", { name: "Pin session", exact: true })).toBeFocused()
})

test("unpin reserves the last page slot while retaining the selected chat", async ({ page }) => {
  const events: Event[] = []
  await setup(page, { events: () => events.splice(0).map((payload) => ({ directory: fixture.directory, payload })) })
  await row(page, fixture.targetID).hover()
  await row(page, fixture.targetID).getByRole("button", { name: "Pin session", exact: true }).click()
  events.push(
    ...Array.from(
      { length: 5 },
      (_, index): Event => ({
        id: `evt_newer_${index}`,
        type: "session.created",
        properties: {
          sessionID: `ses_newer_${index}`,
          info: {
            ...fixture.sessions[0],
            id: `ses_newer_${index}`,
            title: `Newer chat ${index}`,
            time: { created: Date.now() + index, updated: Date.now() + index },
          },
        },
      }),
    ),
  )
  await expect(row(page, "ses_newer_4")).toBeVisible()
  await expect(row(page, fixture.sourceID)).toBeVisible()
  await row(page, fixture.targetID).getByRole("button", { name: "Unpin session", exact: true }).press("Enter")
  await expect(row(page, fixture.targetID).getByRole("button", { name: "Pin session", exact: true })).toBeFocused()
  await expect(row(page, fixture.sourceID)).toBeVisible()
})

// Placement is vertical, so one pass per width covers both directions.
for (const [width, direction] of [
  [1280, "ltr"],
  [390, "rtl"],
] as const) {
  test(`workflow shelves stay collapsed at the bottom at ${width}px ${direction}`, async ({ page }) => {
    const snoozed = { ...fixture.sessions[0], id: "ses_bottom_snoozed", title: "Review later" }
    const settled = { ...fixture.sessions[0], id: "ses_bottom_settled", title: "Finished review" }
    await setup(page, {
      sessions: [...fixture.sessions, snoozed, settled],
      sessionStatus: { [fixture.targetID]: { type: "busy" } },
    })
    await organize(page, snoozed.id, "Snooze for 1 hour")
    await organize(page, settled.id, "Settle")
    await page.setViewportSize({ width, height: 900 })
    await page.locator("html").evaluate((element, value) => element.setAttribute("dir", value), direction)
    if (width === 390) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
    const shelves = page.locator(".cm3-sidebar-shelves")
    for (const value of ["working", "snoozed", "settled"]) {
      const section = shelves.locator(`[data-workflow="${value}"]`)
      await expect(section.locator(".cm-workflow-heading")).toHaveAttribute("aria-expanded", "false")
      await expect(section.locator(".cm-workflow-count")).toHaveText("1")
      await expect(section.getByRole("group")).toHaveCount(0)
    }
    await expect(row(page, fixture.sourceID)).toHaveCount(1)
    await expect(page.locator(".cm3-sidebar-tabs")).toHaveCount(0)
    await expect(page.getByRole("region", { name: "Recent sessions", exact: true })).toHaveCount(0)
    await expect
      .poll(async () => {
        const shelf = await shelves.boundingBox()
        const footer = await page.locator(".cm3-sidebar-footer").boundingBox()
        return !!shelf && !!footer && shelf.y > 500 && Math.abs(shelf.y + shelf.height - footer.y) < 16
      })
      .toBe(true)
    await shelves.getByRole("button", { name: "Working", exact: true }).click()
    await expect(row(page, fixture.targetID)).toBeVisible()
    await shelves.getByRole("button", { name: "Working", exact: true }).click()
  })
}

test("attention and completion bring an older working chat to the top of Inbox", async ({ page }) => {
  const events: Event[] = []
  let busy = true
  await setup(page, {
    sessions: fixture.sessions.map((session) =>
      session.id === fixture.sourceID ? { ...session, time: { ...session.time, updated: Date.now() - 1000 } } : session,
    ),
    sessionStatus: () => (busy ? { [fixture.targetID]: { type: "busy" } } : {}),
    events: () => events.splice(0).map((payload) => ({ directory: fixture.directory, payload })),
  })
  const inbox = rows(page).locator('[data-workflow="inbox"] [data-session-id]')
  await expect(inbox).toHaveCount(1)
  events.push({
    id: "evt_attention_top",
    type: "question.asked",
    properties: {
      id: "question_top",
      sessionID: fixture.targetID,
      questions: [{ header: "Review", question: "Continue?", options: [{ label: "Yes", description: "Continue" }] }],
    },
  })
  await expect(inbox).toHaveCount(2)
  await expect(inbox.nth(0)).toHaveAttribute("data-session-id", fixture.targetID)
  events.push({
    id: "evt_attention_cleared",
    type: "question.rejected",
    properties: {
      sessionID: fixture.targetID,
      requestID: "question_top",
    },
  })
  await expect(inbox).toHaveCount(1)
  busy = false
  events.push({
    id: "evt_complete_top",
    type: "session.status",
    properties: {
      sessionID: fixture.targetID,
      status: { type: "idle" },
    },
  })
  await expect(inbox).toHaveCount(2)
  await expect(inbox.nth(0)).toHaveAttribute("data-session-id", fixture.targetID)
  await expect(row(page, fixture.targetID)).toHaveCount(1)
})
