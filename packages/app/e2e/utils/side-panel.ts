import { expect, type Page } from "@playwright/test"

export async function openPanelFileBrowser(page: Page) {
  const tabs = page.locator(".session-side-panel-tabs")
  await tabs.getByRole("button", { name: "New tab", exact: true }).click()
  const open = page.locator("#review-panel").getByRole("button", { name: "Open file", exact: true })
  await expect(open).toBeVisible()
  await open.click()
  await expect(tabs.getByRole("tab", { name: "Open file", exact: true })).toHaveAttribute("data-selected", "")
}
