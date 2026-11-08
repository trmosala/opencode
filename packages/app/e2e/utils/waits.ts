import { expect, type Locator, type Page } from "@playwright/test"

export const APP_READY_TIMEOUT = 30_000

export async function expectAppVisible(locator: Locator) {
  await expect(locator).toBeVisible({ timeout: APP_READY_TIMEOUT })
}

export async function expectSessionTitle(page: Page, title: string) {
  await expectAppVisible(page.getByRole("heading", { name: title }))
}

// The CM3 sidebar keeps project navigation inside a collapsed <details> below the Inbox.
export async function openSidebarProjects(page: Page) {
  const projects = page.locator("details.cm3-sidebar-project-navigation")
  await expectAppVisible(projects)
  if (!(await projects.evaluate((node: HTMLDetailsElement) => node.open))) await projects.locator("summary").click()
  await expect(projects).toHaveAttribute("open", "")
}
