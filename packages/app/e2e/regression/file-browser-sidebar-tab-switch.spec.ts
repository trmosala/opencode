import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"
import { openPanelFileBrowser } from "../utils/side-panel"

const directory = "C:/OpenCode/FileBrowserSidebar"
const projectID = "proj_file_browser_sidebar"
const sessionID = "ses_file_browser_sidebar"
const title = "File browser sidebar"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const files = Array.from({ length: 80 }, (_, index) => `file-${String(index).padStart(2, "0")}.ts`)
// Marks the file-browser sidebar DOM node so a remount (fresh node) is detectable.
const PROBE = "original"

test.use({ viewport: { width: 1440, height: 900 } })

// The file-browser sidebar must stay mounted across preview/pinned file-tab
// switches. Remounting resets scroll and filter state.
test("keeps the file-browser sidebar mounted when switching file tabs", async ({ page }) => {
  await setup(page)

  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const panel = page.locator("#review-panel")
  const tabs = page.locator(".session-side-panel-tabs")
  await openPanelFileBrowser(page)
  await expect(tabs.getByRole("tab", { name: "Open file" })).toHaveAttribute("data-selected", "")

  const sidebar = panel.locator('[data-component="session-review-v2-sidebar-root"]')
  await expect(sidebar).toBeVisible()
  await expect(panel.getByRole("button", { name: "file-00.ts" })).toBeVisible()

  await panel.getByRole("button", { name: "file-00.ts" }).click()
  await expect(tabs.getByRole("tab", { name: "file-00.ts" })).toHaveAttribute("data-selected", "")
  await expect(panel.getByText("contents:file-00.ts", { exact: true })).toBeVisible()

  const viewport = panel.locator('[data-slot="session-review-v2-sidebar-tree"] .scroll-view__viewport')
  await viewport.hover()
  await page.mouse.wheel(0, 100_000)
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeLessThanOrEqual(1)
  const scrolled = await viewport.evaluate((element) => element.scrollTop)
  expect(scrolled).toBeGreaterThan(0)
  await writeProbe(page)

  await panel.getByRole("button", { name: "file-79.ts" }).click()
  await expect(tabs.getByRole("tab", { name: "file-79.ts" })).toHaveAttribute("data-selected", "")
  await expect(panel.getByText("contents:file-79.ts", { exact: true })).toBeVisible()
  expect(await readProbe(page)).toBe(PROBE)
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(scrolled)

  await panel.getByRole("button", { name: "file-78.ts" }).dblclick()
  await expect(tabs.getByRole("tab", { name: "file-78.ts" })).toHaveAttribute("data-selected", "")
  await panel.getByRole("button", { name: "file-79.ts" }).click()
  await expect(tabs.getByRole("tab", { name: "file-79.ts" })).toHaveAttribute("data-selected", "")
  await tabs.getByRole("tab", { name: "file-78.ts" }).click()
  await expect(tabs.getByRole("tab", { name: "file-78.ts" })).toHaveAttribute("data-selected", "")
  expect(await readProbe(page)).toBe(PROBE)
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(scrolled)
})

for (const direction of ["ltr", "rtl"] as const) {
  test(`CM3 promotes panel tabs and retains their content across layout toggles in ${direction}`, async ({ page }) => {
    await setup(page, ({ query }) => files.filter((file) => file.includes(query)))
    await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
    await expectSessionTitle(page, title)
    if (direction === "rtl") await page.getByRole("button", { name: "DIR: LTR", exact: true }).click()
    await expect(page.locator("html")).toHaveAttribute("dir", direction)

    const header = page.locator('[data-cm3-region="header"]')
    const panel = page.locator("#review-panel")
    const tabs = page.locator(".session-side-panel-tabs")
    const list = tabs.getByRole("tablist")
    await expect(header.getByRole("tablist")).toBeVisible()
    await expect(panel.getByRole("tablist")).toHaveCount(0)
    const originalList = await list.elementHandle()
    await openPanelFileBrowser(page)
    await panel.getByRole("button", { name: "file-00.ts", exact: true }).dblclick()
    await panel.getByRole("button", { name: "file-01.ts", exact: true }).dblclick()
    const filter = panel.getByRole("combobox", { name: "Filter files", exact: true })
    await filter.fill("file-0")
    await expect(panel.getByRole("option", { name: "file-00.ts", exact: true })).toBeVisible()
    const originalSidebar = await panel.locator('[data-component="session-review-v2-sidebar-root"]').elementHandle()

    const cm3 = page.getByRole("switch", { name: "CM3 UI", exact: true })
    await cm3.click()
    await expect(panel.getByRole("tablist")).toBeVisible()
    expect(await list.evaluate((element, original) => element === original, originalList)).toBe(true)
    await expect(filter).toHaveValue("file-0")
    expect(
      await panel
        .locator('[data-component="session-review-v2-sidebar-root"]')
        .evaluate((element, original) => element === original, originalSidebar),
    ).toBe(true)
    await cm3.click()
    await expect(header.getByRole("tablist")).toBeVisible()
    expect(await list.evaluate((element, original) => element === original, originalList)).toBe(true)
    await expect(filter).toHaveValue("file-0")

    // Roving focus still selects content across the portal boundary.
    const first = tabs.getByRole("tab", { name: "file-00.ts", exact: true })
    await first.focus()
    await first.press(direction === "rtl" ? "ArrowLeft" : "ArrowRight")
    await expect(tabs.getByRole("tab", { name: "file-01.ts", exact: true })).toBeFocused()
    await expect(panel.getByText("contents:file-01.ts", { exact: true })).toBeVisible()
    const source = await first.boundingBox()
    const target = await tabs.locator('[data-slot="tabs-trigger-wrapper"][data-value$="file-01.ts"]').boundingBox()
    expect(source).not.toBeNull()
    expect(target).not.toBeNull()
    await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2)
    await page.mouse.down()
    await page.mouse.move(
      direction === "rtl" ? target!.x + 2 : target!.x + target!.width - 2,
      target!.y + target!.height / 2,
      { steps: 10 },
    )
    await page.mouse.up()
    await expect(tabs.locator('[data-slot="tabs-trigger"][data-value^="file://"]')).toHaveText([
      "file-01.ts",
      "file-00.ts",
    ])
    await tabs.getByRole("tab", { name: "file-01.ts", exact: true }).click({ button: "middle" })
    await expect(tabs.getByRole("tab", { name: "file-01.ts", exact: true })).toHaveCount(0)
    await expect(filter).toHaveValue("file-0")

    for (let index = 0; index < 6; index++) {
      await tabs.getByRole("button", { name: "New tab", exact: true }).click()
      await expect(tabs.getByRole("tab", { name: "New tab", exact: true })).toHaveCount(index + 1)
      await expect(tabs.locator('[role="tab"][aria-selected="true"]')).toHaveText("New tab")
    }
    await page.setViewportSize({ width: 1000, height: 900 })
    await expect.poll(() => list.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
    await list.evaluate((element) => element.scrollTo({ left: 0, behavior: "instant" }))
    await list.hover()
    await page.mouse.wheel(0, 500)
    await expect
      .poll(() => list.evaluate((element) => Math.sign(element.scrollLeft)))
      .toBe(direction === "rtl" ? -1 : 1)
    const geometry = await header.evaluate((element) => {
      const header = element.getBoundingClientRect()
      const list = element.querySelector('[role="tablist"]')!.getBoundingClientRect()
      const action = element.querySelector('[aria-label="Toggle review"]')!.getBoundingClientRect()
      return {
        listTop: list.top,
        listBottom: list.bottom,
        headerTop: header.top,
        headerBottom: header.bottom,
        actionTop: action.top,
        actionBottom: action.bottom,
        overflow: element.scrollWidth > element.clientWidth,
      }
    })
    expect(geometry.overflow).toBe(false)
    expect(geometry.listTop).toBeGreaterThanOrEqual(geometry.headerTop)
    expect(geometry.listBottom).toBeLessThanOrEqual(geometry.headerBottom)
    expect(geometry.actionTop).toBeGreaterThanOrEqual(geometry.listTop)
    expect(geometry.actionBottom).toBeLessThanOrEqual(geometry.listBottom)

    const toggle = header.getByRole("button", { name: "Toggle side panel", exact: true })
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    await expect(
      page.locator("#opencode-titlebar-right").getByRole("button", { name: "Toggle review", exact: true }),
    ).toHaveCount(0)
    await toggle.click()
    await expect(panel).toHaveCount(0)
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await toggle.click()
    await expect(panel).toBeVisible()
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    await header.getByRole("tab", { name: "file-00.ts", exact: true }).click()

    const review = header.getByRole("button", { name: "Toggle review", exact: true })
    await review.click()
    await expect(header.getByRole("tab", { name: "Review", exact: true })).toHaveAttribute("data-selected", "")
    await expect(panel).toHaveAttribute("id", "review-panel")
    await review.click()
    await expect(panel).toHaveCount(0)
    await expect(header.getByRole("tablist")).toHaveCount(0)
    await review.click()
    await expect(header.getByRole("tablist")).toBeVisible()
    await expect(header.getByRole("tab", { name: "file-00.ts", exact: true })).toHaveCount(1)
    await page.screenshot({ path: test.info().outputPath(`cm3-panel-tabs-${direction}.png`) })
  })
}

test("keeps previous file search results visible while the next search loads", async ({ page }) => {
  const searchPending = Promise.withResolvers<void>()
  await setup(page, async ({ query }) => {
    if (query === "file-0") return ["file-00.ts"]
    if (query === "file-7") {
      await searchPending.promise
      return ["file-79.ts"]
    }
    return []
  })

  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const panel = page.locator("#review-panel")
  await openPanelFileBrowser(page)
  const filter = panel.getByRole("combobox", { name: "Filter files" })
  await filter.fill("file-0")
  await expect(panel.getByRole("option", { name: "file-00.ts" })).toBeVisible()

  const nextSearch = page.waitForRequest((request) => {
    const url = new URL(request.url())
    return url.pathname === "/find/file" && url.searchParams.get("query") === "file-7"
  })
  await filter.fill("file-7")
  await nextSearch
  await expect(panel.getByRole("option", { name: "file-00.ts" })).toBeVisible()

  searchPending.resolve()
  await expect(panel.getByRole("option", { name: "file-79.ts" })).toBeVisible()
  await expect(panel.getByRole("option", { name: "file-00.ts" })).toBeHidden()
})

type Probed = HTMLElement & { __e2eProbe?: string }

async function writeProbe(page: Page) {
  await page.locator('#review-panel [data-component="session-review-v2-sidebar-root"]').evaluate((el, probe) => {
    ;(el as Probed).__e2eProbe = probe
  }, PROBE)
}

async function readProbe(page: Page) {
  return page
    .locator('#review-panel [data-component="session-review-v2-sidebar-root"]')
    .evaluate((el) => (el as Probed).__e2eProbe)
}

async function setup(
  page: Page,
  findFiles?: (input: { query: string; dirs?: string; limit?: number }) => unknown | Promise<unknown>,
) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "file-browser-sidebar",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { test: { id: "test", name: "Test", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test" },
    },
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    vcsDiff: [],
    fileList: (path) => {
      if (path) return []
      return files.map((name) => ({
        name,
        path: name,
        absolute: `${directory}/${name}`,
        type: "file" as const,
        ignored: false,
      }))
    },
    fileContent: (path) => ({ type: "text", content: `contents:${path}` }),
    findFiles,
    pageMessages: () => ({ items: [] }),
  })

  await page.addInitScript(
    ({ directory, server, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:layout",
        JSON.stringify({ review: { diffStyle: "split", panelOpened: true } }),
      )
      localStorage.setItem(
        "opencode.global.dat:review-panel-v2",
        JSON.stringify({ sidebarOpened: true, sidebarWidth: 240, expandMode: "collapse" }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "session", server, sessionId: sessionID }]),
      )
    },
    { directory, server, sessionID },
  )
}
