import { expect, test } from "@playwright/test"
import { setupTimeline, title } from "../performance/timeline-stability/fixture"

for (const newLayoutDesigns of [false, true]) {
  for (const direction of ["ltr", "rtl"] as const) {
    test(`session controls use leading placement, ${newLayoutDesigns ? "v2" : "legacy"} ${direction}`, async ({
      page,
    }) => {
      await setupTimeline(page, { settings: { newLayoutDesigns }, reducedMotion: true })
      await page.evaluate((direction) => {
        document.documentElement.dir = direction
      }, direction)
      const header = page.locator("[data-session-title]")
      const more = header.getByRole("button", { name: "More options", exact: true })
      const heading = header.getByRole("heading", { name: title, exact: true })
      const context = page.getByRole("button", { name: "View context usage", exact: true })
      const model = page.locator('[data-action="prompt-model"]')
      await expect(more).toBeVisible()
      await expect(model).toBeVisible()
      await expect(context).toBeVisible()
      await expect(header.getByRole("button", { name: "View context usage" })).toHaveCount(0)
      await expect
        .poll(async () => {
          const menuBox = await more.boundingBox()
          const titleBox = await heading.boundingBox()
          if (!menuBox || !titleBox) return false
          return direction === "ltr"
            ? menuBox.x + menuBox.width <= titleBox.x
            : menuBox.x >= titleBox.x + titleBox.width
        })
        .toBe(true)
      await expect
        .poll(async () => {
          const contextBox = await context.boundingBox()
          const modelBox = await model.boundingBox()
          if (!contextBox || !modelBox) return false
          return (
            Math.abs(contextBox.y + contextBox.height / 2 - modelBox.y - modelBox.height / 2) < 2 &&
            (direction === "ltr"
              ? contextBox.x + contextBox.width <= modelBox.x
              : contextBox.x >= modelBox.x + modelBox.width)
          )
        })
        .toBe(true)
      await more.click()
      const menu = page.getByRole("menu")
      await expect(menu.getByRole("menuitem", { name: "Rename", exact: true })).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(menu).toBeHidden()
      await context.click()
      await expect(page.getByRole("tab", { name: "Context", exact: true })).toHaveAttribute("aria-selected", "true")
      await context.click()
      await expect(page.getByRole("tab", { name: "Context", exact: true })).toHaveCount(0)
      const editor = page.locator('[data-component="prompt-input"] [contenteditable="true"]')
      await editor.press("!")
      await expect(context).toBeHidden()
      await editor.press("Backspace")
      await expect(context).toBeVisible()
    })
  }
}
