import { expect, test, type Page } from "@playwright/test"
import { fixture, pageMessages } from "../performance/timeline/session-timeline-stress.fixture"
import {
  installStressSessionTabs,
  mockStressTimeline,
  stressSessionHref,
} from "../performance/timeline/timeline-test-helpers"
import { expectSessionTitle } from "../utils/waits"
import { mockOpenCodeServer } from "../utils/mock-server"

test("CM3 moves the live tabs into the sidebar and keeps their lifecycle", async ({ page }) => {
  await mockStressTimeline(page)
  await installStressSessionTabs(page, { draftID: "draft_cm3_tabs" })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, quietCompanion: true } }))
  })
  await page.goto("/new-session?draftId=draft_cm3_tabs")
  const sidebar = page.locator(".cm3-sidebar-tabs")
  const strip = page.locator('[data-slot="titlebar-tabs"]')
  const slots = sidebar.locator("[data-titlebar-tab-slot]")
  await expect(strip).toHaveCount(1)
  await expect(page.locator('[data-slot="titlebar-v2"] [data-slot="titlebar-tabs"]')).toHaveCount(0)
  await expect(slots).toHaveCount(3)
  await expect(sidebar.getByRole("link", { name: "New session", exact: true })).toBeVisible()
  const input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  await input.fill("Keep this unsent tab")
  const originalStrip = await strip.elementHandle()
  await page.getByRole("switch", { name: "CM3 UI", exact: true }).click()
  await expect(page.locator('[data-slot="titlebar-v2"] [data-slot="titlebar-tabs"]')).toBeVisible()
  await expect(input).toHaveText("Keep this unsent tab")
  await page.getByRole("switch", { name: "CM3 UI", exact: true }).click()
  await expect(sidebar.locator('[data-slot="titlebar-tabs"]')).toBeVisible()
  expect(await strip.evaluate((element, original) => element === original, originalStrip)).toBe(true)

  await sidebar.locator(`[data-titlebar-tab-link][href="${stressSessionHref(fixture.sourceID)}"]`).click()
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  await page.getByRole("button", { name: fixture.expected.sourceTitle, exact: true }).click()
  await expect(slots).toHaveCount(3)
  await page.getByRole("button", { name: "New chat", exact: true }).click()
  await expect(slots).toHaveCount(4)
  await expect(input).toHaveText("")
  await sidebar
    .locator('[data-titlebar-tab-slot][data-active="true"]')
    .getByRole("button", { name: "Close tab", exact: true })
    .click()
  await expect(slots).toHaveCount(3)
  await expect(page).toHaveURL(/draftId=draft_cm3_tabs/)
  await expect(input).toHaveText("Keep this unsent tab")

  const target = sidebar.locator(`[data-titlebar-tab-link][href="${stressSessionHref(fixture.targetID)}"]`)
  await target.click({ button: "middle" })
  await expect(slots).toHaveCount(2)
  await page.getByRole("button", { name: "Reopen closed tab", exact: true }).click()
  await expect(slots).toHaveCount(3)
  await expect(page).toHaveURL(new RegExp(fixture.targetID))
  await page.keyboard.press("Control+1")
  await expect(page).toHaveURL(new RegExp(fixture.sourceID))
  await page.keyboard.press("Control+Tab")
  await expect(page).toHaveURL(new RegExp(fixture.targetID))

  const renamed = page.waitForRequest(
    (request) => request.method() === "PATCH" && new URL(request.url()).pathname === `/session/${fixture.targetID}`,
  )
  await target.locator("[data-titlebar-tab-title]").dblclick()
  const title = target.locator('[contenteditable="true"]')
  await title.fill("Renamed sidebar tab")
  await title.press("Enter")
  expect((await renamed).postDataJSON()).toEqual({ title: "Renamed sidebar tab" })
  await expect(target).toContainText("Renamed sidebar tab")

  const sourceBox = await sidebar
    .locator(`[data-titlebar-tab-link][href="${stressSessionHref(fixture.sourceID)}"]`)
    .boundingBox()
  const targetBox = await sidebar
    .locator(`[data-titlebar-tab-link][href="${stressSessionHref(fixture.targetID)}"]`)
    .boundingBox()
  expect(sourceBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  await page.mouse.move(sourceBox!.x + 30, sourceBox!.y + sourceBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox!.x + 30, targetBox!.y + targetBox!.height - 2, { steps: 10 })
  await page.mouse.up()
  await expect(slots.locator("[data-titlebar-tab-title]")).toHaveText([
    "Renamed sidebar tab",
    fixture.expected.sourceTitle,
    "New session",
  ])
})

test("cold CM3 sessions hydrate their project before starting a new chat", async ({ page }) => {
  await mockStressTimeline(page)
  await installStressSessionTabs(page, { sessionIDs: [fixture.sourceID] })
  await page.addInitScript(
    ({ directory }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, quietCompanion: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: {
            local: [
              { worktree: "C:/OpenCode/OtherProject", expanded: true },
              { worktree: directory, expanded: true },
            ],
          },
          lastProject: { local: "C:/OpenCode/OtherProject" },
        }),
      )
      const tabs = JSON.parse(localStorage.getItem("opencode.window.browser.dat:tabs") ?? "[]")
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify(
          tabs.map((tab: { type: string; server: string; sessionId: string }) => ({
            type: tab.type,
            server: tab.server,
            sessionId: tab.sessionId,
          })),
        ),
      )
    },
    { directory: fixture.directory },
  )
  await page.goto(stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  const project = page.locator(`.cm3-sidebar-project[title="${fixture.directory}"]`)
  await expect(project).toHaveAttribute("data-active", "true")
  const projectName = (await project.locator(":scope > span").innerText()).trim()
  await page.getByRole("button", { name: "New chat", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: `What should we build in ${projectName}?`, exact: true }),
  ).toBeVisible()
})

for (const remote of [false, true]) {
  test(`CM3 New chat uses the selected ${remote ? "server and " : ""}project`, async ({ page }) => {
    await mockStressTimeline(page)
    await mockCm3Projects(page)
    await installStressSessionTabs(page)
    const selectedServer = remote
      ? `http://cm3-selected.test:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
      : `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
    await page.addInitScript(
      ({ directory, selectedServer, remote }) => {
        localStorage.setItem(
          "settings.v3",
          JSON.stringify({ general: { newLayoutDesigns: true, quietCompanion: true } }),
        )
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({
            list: remote ? [{ type: "http", http: { url: selectedServer }, displayName: "Selected server" }] : [],
            projects: {
              local: [{ worktree: directory, expanded: true }],
              [remote ? selectedServer : "local"]: [
                ...(!remote ? [{ worktree: directory, expanded: true }] : []),
                { worktree: "C:/OpenCode/OtherProject", expanded: true },
              ],
            },
            lastProject: { local: directory },
          }),
        )
      },
      { directory: fixture.directory, selectedServer, remote },
    )
    await page.goto(stressSessionHref(fixture.sourceID))
    await expectSessionTitle(page, fixture.expected.sourceTitle)
    const selected = page.locator('.cm3-sidebar-project[title="C:/OpenCode/OtherProject"]')
    await selected.click()
    await expect(selected).toHaveAttribute("data-active", "true")
    await page.getByRole("button", { name: "New chat", exact: true }).click()
    await expect(
      page.getByRole("heading", { name: "What should we build in OtherProject?", exact: true }),
    ).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(() => {
          const draftID = new URLSearchParams(location.search).get("draftId")
          return JSON.parse(localStorage.getItem("opencode.window.browser.dat:tabs") ?? "[]").find(
            (tab: { draftID?: string }) => tab.draftID === draftID,
          )
        }),
      )
      .toMatchObject({ type: "draft", server: selectedServer, directory: "C:/OpenCode/OtherProject" })
  })
}

test("CM3 projects retain editing, closing, and persistent drag ordering", async ({ page }) => {
  await mockStressTimeline(page)
  await mockCm3Projects(page)
  await page.addInitScript(
    ({ directory }) => {
      if (localStorage.getItem("settings.v3")) return
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, quietCompanion: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: {
            local: [directory, "C:/OpenCode/OtherProject", "C:/OpenCode/ThirdProject"].map((worktree) => ({
              worktree,
              expanded: true,
            })),
          },
          lastProject: { local: directory },
        }),
      )
    },
    { directory: fixture.directory },
  )
  await page.goto("/")
  const projects = page.getByRole("complementary", { name: "Projects", exact: true })
  const other = projects.locator('[data-component="home-project-row"][title="C:/OpenCode/OtherProject"]')
  const third = projects.locator('[data-component="home-project-row"][title="C:/OpenCode/ThirdProject"]')
  await expect(other).toBeEnabled()
  await expect(third).toBeEnabled()
  const otherBox = await other.boundingBox()
  const thirdBox = await third.boundingBox()
  expect(otherBox).not.toBeNull()
  expect(thirdBox).not.toBeNull()
  await page.mouse.move(otherBox!.x + 30, otherBox!.y + otherBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(thirdBox!.x + 30, thirdBox!.y + thirdBox!.height - 2, { steps: 10 })
  await page.mouse.up()
  await expect(projects.locator('[data-component="home-project-row"] > span')).toHaveText([
    fixture.project.name,
    "ThirdProject",
    "OtherProject",
  ])
  await other.click({ button: "right" })
  await page.getByRole("menuitem", { name: "Edit project", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Edit project", exact: true })
  await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("OtherProject")
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Renamed project")
  await dialog.getByRole("button", { name: "Save", exact: true }).click()
  await expect(other.locator(":scope > span")).toHaveText("Renamed project")
  await third.click({ button: "right" })
  await page.getByRole("menuitem", { name: "Close", exact: true }).click()
  await expect(third).toHaveCount(0)
  await page.reload()
  await expect(projects.locator('[data-component="home-project-row"] > span')).toHaveText([
    fixture.project.name,
    "Renamed project",
  ])
})

async function mockCm3Projects(page: Page) {
  const projects = [
    fixture.project,
    ...["OtherProject", "ThirdProject"].map((name) => ({
      ...fixture.project,
      id: `proj_cm3_${name}`,
      name,
      worktree: `C:/OpenCode/${name}`,
    })),
  ]
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url())
    const project =
      projects.find(
        (item) => item.worktree === (url.searchParams.get("location[directory]") ?? url.searchParams.get("directory")),
      ) ?? projects[0]
    const target = projects.find((item) => url.pathname === `/project/${item.id}`)
    if (target && route.request().method() === "PATCH") Object.assign(target, route.request().postDataJSON())
    const body =
      url.pathname === "/project" || url.pathname === "/api/project"
        ? projects
        : url.pathname === "/project/current"
          ? project
          : url.pathname === "/api/project/current"
            ? { id: project.id, directory: project.worktree }
            : url.pathname === "/path" || url.pathname === "/api/path"
              ? {
                  state: project.worktree,
                  config: project.worktree,
                  worktree: project.worktree,
                  directory: project.worktree,
                  home: "C:/OpenCode",
                }
              : target
    if (!body) return route.fallback()
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(body),
    })
  })
}

test("CM3 mobile navigation is named and returns keyboard focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  await mockStressTimeline(page)
  await installStressSessionTabs(page)
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, quietCompanion: true } }))
  })
  await page.goto(stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  const toggle = page.getByRole("button", { name: "Toggle sidebar", exact: true })
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  const navigation = page.getByRole("complementary", { name: "Projects and sessions", exact: true })
  await expect(navigation.getByRole("button", { name: "New chat", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await expect(toggle).toBeFocused()
})

test("titlebar UI and color switches persist across reloads", async ({ page }) => {
  await mockStressTimeline(page)
  await installStressSessionTabs(page)
  await page.addInitScript(() => {
    if (!localStorage.getItem("settings.v3"))
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, quietCompanion: true } }))
  })
  await page.goto(stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  const controls = page.locator('[data-component="titlebar-appearance"]')
  const ui = controls.getByRole("switch", { name: "CM3 UI", exact: true })
  const dark = controls.getByRole("switch", { name: "Dark", exact: true })
  await expect(ui).toHaveAttribute("aria-checked", "true")
  await ui.click()
  await expect(page.locator(".cm3-live")).toHaveCount(0)
  await ui.click()
  await expect(page.locator(".cm3-live")).toBeVisible()
  const initial = await dark.getAttribute("aria-checked")
  await dark.click()
  await expect(dark).toHaveAttribute("aria-checked", initial === "true" ? "false" : "true")
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", initial === "true" ? "light" : "dark")
  await page.reload()
  await expect(ui).toHaveAttribute("aria-checked", "true")
  await expect(dark).toHaveAttribute("aria-checked", initial === "true" ? "false" : "true")
})

test("CM3 home keeps project navigation in the sidebar", async ({ page }) => {
  await mockStressTimeline(page)
  await installStressSessionTabs(page)
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, quietCompanion: true } }))
  })
  await page.goto("/")
  await expect(page.locator(".cm3-sidebar-project").first()).toBeVisible()
  await expect(page.locator('[data-slot="home-projects-scroll"]')).toHaveCount(0)
  await expect(page.locator(".cm3-sidebar-footer").getByRole("button", { name: "Projects", exact: true })).toHaveCount(
    0,
  )
  await page.getByRole("switch", { name: "CM3 UI", exact: true }).click()
  await expect(page.locator('[data-slot="home-projects-scroll"]')).toBeVisible()
})

test("CM3 uses the live session and preserves its editor across UI switches", async ({ page }, testInfo) => {
  await mockStressTimeline(page)
  await installStressSessionTabs(page)
  await page.addInitScript(() => {
    if (!localStorage.getItem("settings.v3"))
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, quietCompanion: true } }))
  })
  await page.goto(stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  await expect(page.locator(".cm3-live")).toBeVisible()
  await expect(page.locator('[data-cm3-region="session"]')).toBeVisible()
  const input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  await expect(input).toHaveCount(1)
  await input.fill("Preserve this live draft")
  await page.route("**/pty/shells", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "[]",
      headers: { "access-control-allow-origin": "*" },
    }),
  )
  const editor = await input.elementHandle()
  await page.screenshot({ path: testInfo.outputPath("cm3-live-session.png") })
  await page.getByRole("switch", { name: "CM3 UI", exact: true }).click()
  await expect(page.locator(".cm3-live")).toHaveCount(0)
  await expect(input).toHaveText("Preserve this live draft")
  expect(await input.evaluate((element, original) => element === original, editor)).toBe(true)
  await page.keyboard.press("Control+Comma")
  const toggle = page.locator('[data-action="settings-quiet-companion"]').getByRole("switch")
  await expect(toggle).toBeVisible()
  await toggle.press("Space")
  await expect(page.locator(".cm3-live")).toBeVisible()
  await expect(input).toHaveText("Preserve this live draft")
  expect(await input.evaluate((element, original) => element === original, editor)).toBe(true)
  await expect(page).toHaveURL(new RegExp(fixture.sourceID))
  await page.reload()
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  await expect(page.locator(".cm3-live")).toBeVisible()
  await expect(input).toHaveText("Preserve this live draft")
  await page.route(`**/session/${fixture.sourceID}/prompt_async`, (route) =>
    route.fulfill({
      status: 204,
      headers: { "access-control-allow-origin": "*" },
    }),
  )
  const submitted = page.waitForRequest(
    (request) =>
      request.method() === "POST" && new URL(request.url()).pathname === `/session/${fixture.sourceID}/prompt_async`,
  )
  await input.press("Enter")
  const request = await submitted
  expect(request.postDataJSON()).toMatchObject({ parts: [{ type: "text", text: "Preserve this live draft" }] })
  await expect(input).toHaveText("")
})

test("CM3 landing suggestions edit the real project draft", async ({ page }, testInfo) => {
  await mockStressTimeline(page)
  await installStressSessionTabs(page, { draftID: "draft_cm3_live" })
  await page.addInitScript(() => {
    if (!localStorage.getItem("settings.v3"))
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, quietCompanion: true } }))
  })
  await page.goto("/new-session?draftId=draft_cm3_live")
  await expect(page.locator('[data-cm3-thread="false"]')).toBeVisible()
  await expect(page.getByRole("heading", { name: "What should we build in SmokeProject?", exact: true })).toBeVisible()
  const input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  await expect(input).toHaveCount(1)
  await page.getByRole("button", { name: "Trace a bug", exact: true }).click()
  await expect(input).toHaveText("Help me trace a bug. Here is what happened:")
  await expect(input).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath("cm3-live-landing.png") })
})

for (const scheme of ["light", "dark"] as const) {
  for (const width of [1280, 390]) {
    test(`CM3 ${scheme} ${width}px session keeps the live composer on screen`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 800 })
      await mockStressTimeline(page)
      await installStressSessionTabs(page)
      await page.addInitScript((scheme) => {
        localStorage.setItem(
          "settings.v3",
          JSON.stringify({ general: { newLayoutDesigns: true, quietCompanion: true } }),
        )
        localStorage.setItem("opencode-color-scheme", scheme)
      }, scheme)
      await page.goto(stressSessionHref(fixture.sourceID))
      await expectSessionTitle(page, fixture.expected.sourceTitle)
      const composer = page.locator('[data-cm3-region="composer"]')
      await expect(composer).toBeVisible()
      await expect(page.locator("html")).toHaveAttribute("data-color-scheme", scheme)
      const box = await composer.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1)
      expect(box!.y + box!.height).toBeLessThanOrEqual(801)
      await page.screenshot({ path: testInfo.outputPath(`cm3-session-${scheme}-${width}.png`) })
    })
  }
}

test("CM3 mobile Review opens actual changes and returns to the live draft", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  await mockStressTimeline(page)
  await installStressSessionTabs(page)
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, quietCompanion: true } }))
  })
  await page.goto(stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  const input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  await input.fill("Mobile draft")
  const review = page.locator('[data-cm3-region="header"]').getByRole("button", { name: "Toggle review", exact: true })
  await expect(review).toHaveAttribute("aria-pressed", "false")
  await review.click()
  await expect(review).toHaveAttribute("aria-pressed", "true")
  await expect(input).not.toBeVisible()
  await review.click()
  await expect(review).toHaveAttribute("aria-pressed", "false")
  await expect(input).toBeVisible()
  await expect(input).toHaveText("Mobile draft")
})

for (const newLayout of [true, false]) {
  test(`CM3 dark ${newLayout ? "V2" : "legacy"} landing is the live draft`, async ({ page }, testInfo) => {
    await mockStressTimeline(page)
    await installStressSessionTabs(page, { draftID: "draft_cm3_dark" })
    await page.addInitScript((newLayout) => {
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ general: { newLayoutDesigns: newLayout, quietCompanion: true } }),
      )
      localStorage.setItem("opencode-color-scheme", "dark")
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.18.34" }))
    }, newLayout)
    if (!newLayout) await page.clock.install({ time: new Date("2026-09-01T10:00:00Z") })
    await page.goto(
      newLayout
        ? "/new-session?draftId=draft_cm3_dark"
        : `/${Buffer.from(fixture.directory).toString("base64url")}/session`,
    )
    await expect(page.locator('[data-cm3-thread="false"]')).toBeVisible()
    if (newLayout) {
      await expect(
        page.getByRole("heading", { name: "What should we build in SmokeProject?", exact: true }),
      ).toBeVisible()
    } else {
      const landing = page.locator('[data-component="cm3-legacy-landing"]')
      await expect(landing).toBeVisible()
      await expect(landing.getByText("What should we build in smoke-project?", { exact: true })).toBeVisible()
    }
    const input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
    await expect(input).toHaveCount(1)
    await page.getByRole("button", { name: "Trace a bug", exact: true }).click()
    await expect(input).toHaveText("Help me trace a bug. Here is what happened:")
    await page.screenshot({ path: testInfo.outputPath(`cm3-landing-dark-${newLayout ? "v2" : "legacy"}.png`) })
  })
}

test("CM3 desktop Review and sidebar search use live session state", async ({ page }) => {
  await mockStressTimeline(page)
  await installStressSessionTabs(page)
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, quietCompanion: true } }))
  })
  await page.goto(stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  const review = page.locator('[data-cm3-region="header"]').getByRole("button", { name: "Toggle review", exact: true })
  await review.click()
  await expect(review).toHaveAttribute("aria-pressed", "true")
  await expect(page.locator("#review-panel")).toBeVisible()
  await review.click()
  await expect(review).toHaveAttribute("aria-pressed", "false")
  await expect(page.locator("#review-panel")).toHaveCount(0)
  await review.click()
  await expect(review).toHaveAttribute("aria-pressed", "true")
  await expect(page.locator("#review-panel")).toBeVisible()
  await expect(page.locator(".qc-preview-diff")).toHaveCount(0)
  const navigation = page.getByRole("complementary", { name: "Projects and sessions", exact: true })
  const search = navigation.getByRole("searchbox", { name: "Search threads", exact: true })
  await search.fill(fixture.expected.targetTitle)
  const target = navigation.getByRole("button", { name: fixture.expected.targetTitle, exact: true })
  await expect(target).toBeVisible()
  await expect(navigation.getByRole("button", { name: fixture.expected.sourceTitle, exact: true })).toHaveCount(0)
  await target.click()
  await expectSessionTitle(page, fixture.expected.targetTitle)
  await expect(page).toHaveURL(new RegExp(fixture.targetID))
  await expect(page.locator('[data-component="prompt-input"][contenteditable="true"]')).toHaveCount(1)
})

test("CM3 recent threads show running status and unscoped project names", async ({ page }) => {
  await mockOpenCodeServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
    sessionStatus: { [fixture.targetID]: { type: "busy" } },
  })
  await installCm3Sidebar(page)
  await page.goto("/")
  const recent = page.locator(".cm3-sidebar-task").filter({ hasText: fixture.expected.targetTitle })
  await expect(recent.locator('[data-component="session-progress-indicator-v2"]')).toBeVisible()
  await expect(recent.locator(".cm3-sidebar-task-project")).toHaveText(fixture.project.name)
  await recent.click()
  await expectSessionTitle(page, fixture.expected.targetTitle)
  await expect(recent.locator(".cm3-sidebar-task-project")).toHaveCount(0)
})

for (const kind of ["permission", "question"] as const) {
  test(`CM3 recent threads flag a pending ${kind} instead of running progress`, async ({ page }) => {
    await mockOpenCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages,
      sessionStatus: { [fixture.targetID]: { type: "busy" } },
      permissions:
        kind === "permission"
          ? [
              {
                id: "cm3_permission",
                sessionID: fixture.targetID,
                permission: "bash",
                patterns: ["git status"],
                metadata: {},
                always: [],
              },
            ]
          : [],
      questions:
        kind === "question"
          ? [
              {
                id: "cm3_question",
                sessionID: fixture.targetID,
                questions: [{ header: "Choice", question: "Proceed?", options: [] }],
              },
            ]
          : [],
    })
    await installCm3Sidebar(page)
    await page.goto(stressSessionHref(fixture.sourceID))
    await expectSessionTitle(page, fixture.expected.sourceTitle)
    const recent = page.locator(".cm3-sidebar-task").filter({ hasText: fixture.expected.targetTitle })
    await expect(recent.locator('[data-slot="project-avatar-unread-dot"]')).toBeVisible()
    await expect(recent.locator('[data-component="session-progress-indicator-v2"]')).toHaveCount(0)
  })
}

test("CM3 recent threads show unread completion notifications", async ({ page }) => {
  await mockStressTimeline(page)
  await installCm3Sidebar(page)
  await page.addInitScript(
    ({ directory, session }) => {
      localStorage.setItem(
        "opencode.global.dat:notification",
        JSON.stringify({ list: [{ type: "turn-complete", directory, session, time: Date.now(), viewed: false }] }),
      )
    },
    { directory: fixture.directory, session: fixture.targetID },
  )
  await page.goto(stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  const recent = page.locator(".cm3-sidebar-task").filter({ hasText: fixture.expected.targetTitle })
  await expect(recent.locator('[data-slot="project-avatar-unread-dot"]')).toBeVisible()
  await recent.click()
  await expectSessionTitle(page, fixture.expected.targetTitle)
  await expect(recent.locator('[data-slot="project-avatar-unread-dot"]')).toHaveCount(0)
})

for (const gesture of ["Control", "Meta", "middle"] as const) {
  test(`CM3 recent thread ${gesture} opening preserves the active draft and mobile drawer`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await mockStressTimeline(page)
    const draftID = `draft_cm3_background_${gesture}`
    await installCm3Sidebar(page, { sessionIDs: [fixture.sourceID], draftID })
    await page.addInitScript(
      (mac) => Object.defineProperty(navigator, "platform", { value: mac ? "MacIntel" : "Win32" }),
      gesture === "Meta",
    )
    await page.goto(`/new-session?draftId=${draftID}`)
    const input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
    await expect(input).toBeVisible()
    await input.fill("Keep my active draft")
    const toggle = page.getByRole("button", { name: "Toggle sidebar", exact: true })
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    const recent = page.locator(".cm3-sidebar-task").filter({ hasText: fixture.expected.targetTitle })
    await recent.click(gesture === "middle" ? { button: "middle" } : { modifiers: [gesture] })
    const tab = page.locator(
      `.cm3-sidebar-tabs [data-titlebar-tab-link][href="${stressSessionHref(fixture.targetID)}"]`,
    )
    await expect(tab).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`draftId=${draftID}`))
    await expect(input).toHaveText("Keep my active draft")
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    await recent.click()
    await expectSessionTitle(page, fixture.expected.targetTitle)
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await toggle.click()
    await page.locator(`.cm3-sidebar-tabs [data-titlebar-tab-link][href="/new-session?draftId=${draftID}"]`).click()
    await expect(input).toHaveText("Keep my active draft")
  })
}

test("CM3 sidebar search supports arrows, Enter, empty results and composition", async ({ page }) => {
  await mockStressTimeline(page)
  await installCm3Sidebar(page)
  await page.goto(stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  const sidebar = page.getByRole("complementary", { name: "Projects and sessions", exact: true })
  const search = sidebar.getByRole("searchbox", { name: "Search threads", exact: true })
  await search.fill("No matching thread")
  await expect(sidebar.locator(".cm3-sidebar-task")).toHaveCount(0)
  await search.press("ArrowDown")
  await search.press("Enter")
  await expect(search).toBeFocused()
  await expect(page).toHaveURL(new RegExp(fixture.sourceID))
  await search.fill(fixture.expected.targetTitle)
  const target = sidebar.getByRole("button", { name: fixture.expected.targetTitle, exact: true })
  await expect(target).toBeVisible()
  await search.dispatchEvent("keydown", { key: "ArrowDown", isComposing: true })
  await search.dispatchEvent("keydown", { key: "Enter", isComposing: true })
  await expect(search).toBeFocused()
  await expect(page).toHaveURL(new RegExp(fixture.sourceID))
  await search.press("ArrowUp")
  await expect(target).toBeFocused()
  await target.press("ArrowDown")
  await expect(target).toBeFocused()
  await target.press("Enter")
  await expectSessionTitle(page, fixture.expected.targetTitle)
  await search.fill(fixture.expected.sourceTitle)
  await search.press("Enter")
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  await search.fill("")
  await expect(sidebar.locator(".cm3-sidebar-task")).toHaveCount(2)
  const source = sidebar.getByRole("button", { name: fixture.expected.sourceTitle, exact: true })
  await search.press("ArrowDown")
  await expect(target).toBeFocused()
  await target.press("ArrowDown")
  await expect(source).toBeFocused()
  await source.press("ArrowDown")
  await expect(target).toBeFocused()
  await target.press("ArrowUp")
  await expect(source).toBeFocused()
  await source.press("Enter")
  await expectSessionTitle(page, fixture.expected.sourceTitle)
})

for (const control of ["link", "close"] as const) {
  test(`CM3 mobile Escape closes the drawer from a portaled tab ${control}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await mockStressTimeline(page)
    await installCm3Sidebar(page)
    await page.goto(stressSessionHref(fixture.sourceID))
    await expectSessionTitle(page, fixture.expected.sourceTitle)
    const toggle = page.getByRole("button", { name: "Toggle sidebar", exact: true })
    await toggle.click()
    const slot = page.locator(
      `.cm3-sidebar-tabs [data-titlebar-tab-slot]:has([data-titlebar-tab-link][href="${stressSessionHref(fixture.sourceID)}"])`,
    )
    const target =
      control === "link"
        ? slot.locator("[data-titlebar-tab-link]")
        : slot.getByRole("button", { name: "Close tab", exact: true })
    await expect(target).toBeVisible()
    await target.focus()
    await expect(target).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await expect(toggle).toBeFocused()
  })
}

test("CM3 mobile focus stays in the drawer and Escape cancels tab rename first", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  await mockStressTimeline(page)
  await installCm3Sidebar(page)
  await page.goto(stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  const toggle = page.getByRole("button", { name: "Toggle sidebar", exact: true })
  await toggle.click()
  const sidebar = page.getByRole("complementary", { name: "Projects and sessions", exact: true })
  const close = sidebar.getByRole("button", { name: "Close navigation", exact: true })
  const settings = sidebar.getByRole("button", { name: "Settings", exact: true })
  await expect(close).toBeFocused()
  await close.press("Shift+Tab")
  await expect(settings).toBeFocused()
  await settings.press("Tab")
  await expect(close).toBeFocused()
  const search = sidebar.getByRole("searchbox", { name: "Search threads", exact: true })
  await search.focus()
  await search.press("Tab")
  await expect(sidebar.locator(`[data-titlebar-tab-link][href="${stressSessionHref(fixture.sourceID)}"]`)).toBeFocused()
  const title = sidebar.locator(
    `[data-titlebar-tab-link][href="${stressSessionHref(fixture.sourceID)}"] [data-titlebar-tab-title]`,
  )
  await title.dblclick()
  await expect(title).toHaveAttribute("contenteditable", "true")
  await title.fill("Cancel this rename")
  await title.press("Escape")
  await expect(title).toHaveText(fixture.expected.sourceTitle)
  await expect(title).not.toHaveAttribute("contenteditable", "true")
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await close.focus()
  await close.press("Escape")
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
})

test("CM3 Help opens the original feedback destination", async ({ page, context }) => {
  await mockStressTimeline(page)
  await installCm3Sidebar(page)
  await context.route("https://opencode.ai/desktop-feedback", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "Help destination" }),
  )
  await page.goto("/")
  const help = page.locator(".cm3-sidebar-footer").getByRole("button", { name: "Help", exact: true })
  await expect(help).toBeVisible()
  const opened = context.waitForEvent("page")
  await help.click()
  const feedback = await opened
  await expect(feedback).toHaveURL("https://opencode.ai/desktop-feedback")
  await feedback.close()
})

async function installCm3Sidebar(page: Page, input?: Parameters<typeof installStressSessionTabs>[1]) {
  await installStressSessionTabs(page, input)
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, quietCompanion: true } }))
  })
}
