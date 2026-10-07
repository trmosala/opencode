import { expect, test } from "@playwright/test"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"
import {
  installStressSessionTabs,
  mockStressTimeline,
  stressSessionHref,
} from "../performance/timeline/timeline-test-helpers"
import { expectSessionTitle } from "../utils/waits"

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
  const projectName = (await project.innerText()).trim()
  await page.getByRole("button", { name: "New chat", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: `What should we build in ${projectName}?`, exact: true }),
  ).toBeVisible()
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
  await page.getByRole("button", { name: "Back to Current UI", exact: true }).click()
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
  await page.getByRole("button", { name: "Back to Current UI", exact: true }).click()
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
