import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, test } from "@playwright/test"
import { Schema } from "effect"

// Opt in with an isolated desktop scheduler and the local app dev server.
// Never create tasks in the user's ordinary sidecar during the general E2E suite.
const backend = process.env.SCHEDULING_TEST_SERVER
test.use({ channel: process.env.SCHEDULING_TEST_CHANNEL })
test.skip(!backend, "Requires an isolated scheduler via SCHEDULING_TEST_SERVER")

test("creates, edits, pauses and deletes a task through the scheduled UI", async ({ page }, info) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cm-schedule-ui-"))
  const name = `Scheduled UI ${crypto.randomUUID()}`
  const edited = `${name} edited`
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.addInitScript((url) => {
      localStorage.setItem("opencode.settings.dat:defaultServerUrl", url)
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ list: [url], projects: {}, lastProject: {} }))
    }, backend ?? "")
    await page.goto("/scheduled")
    const scheduled = page.getByRole("region", { name: "Scheduled", exact: true })
    await expect(scheduled.getByRole("heading", { name: "Scheduled", exact: true })).toBeVisible()
    await expect(scheduled.getByRole("button", { name: "Refresh scheduled tasks" })).toBeEnabled()
    await page.screenshot({ path: info.outputPath("scheduled-empty.png"), fullPage: true })
    await scheduled.locator("header").getByRole("button", { name: "New task", exact: true }).click()
    const editor = page.getByRole("dialog", { name: "New task", exact: true })
    await expect(editor.getByLabel("Name", { exact: true })).toBeFocused()
    await editor.getByLabel("Name", { exact: true }).fill(name)
    await editor.getByLabel("Instructions").fill("Summarize recent changes for review.")
    await editor.getByLabel("Project folder", { exact: true }).fill(directory)
    await editor.getByLabel("Model", { exact: true }).selectOption("cookiemonster/CM_GPT6_Sol_High")
    await editor.getByLabel("Schedule", { exact: true }).selectOption("once")
    await editor.getByLabel("Starts at").fill("2030-10-08T09:00")
    await page.screenshot({ path: info.outputPath("scheduled-editor.png"), fullPage: true })
    await editor.getByRole("button", { name: "Save task" }).click()
    await expect(editor).not.toBeVisible()
    const task = scheduled.getByRole("article").filter({ has: page.getByRole("button", { name, exact: true }) })
    await expect(task.getByText("Active", { exact: true })).toBeVisible()
    await task.getByRole("button", { name: "Pause", exact: true }).click()
    await expect(task.getByText("Paused", { exact: true })).toBeVisible()
    await task.getByRole("button", { name: "Resume", exact: true }).click()
    await expect(task.getByText("Active", { exact: true })).toBeVisible()
    await task.getByRole("button", { name: "Edit", exact: true }).click()
    const edit = page.getByRole("dialog", { name: "Edit scheduled task", exact: true })
    await expect(edit.getByLabel("Starts at")).toHaveValue("2030-10-08T09:00")
    await expect(edit.getByLabel("Model", { exact: true })).toHaveValue("cookiemonster/CM_GPT6_Sol_High")
    await edit.getByLabel("Name", { exact: true }).fill(edited)
    await edit.getByRole("button", { name: "Save task" }).click()
    await expect(edit).not.toBeVisible()
    const updated = scheduled
      .getByRole("article")
      .filter({ has: page.getByRole("button", { name: edited, exact: true }) })
    await expect(updated).toBeVisible()
    await page.reload()
    await expect(updated).toBeVisible()
    await page.screenshot({ path: info.outputPath("scheduled-desktop.png"), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(updated.getByRole("button", { name: "Edit", exact: true })).toBeVisible()
    await page.screenshot({ path: info.outputPath("scheduled-mobile.png"), fullPage: true })
    await expect.poll(() => scheduled.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await updated.getByRole("button", { name: "Delete", exact: true }).click()
    const confirm = page.getByRole("dialog", { name: "Delete scheduled task", exact: true })
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(updated).toBeVisible()
    await updated.getByRole("button", { name: "Delete", exact: true }).click()
    await confirm.getByRole("button", { name: "Delete", exact: true }).click()
    await expect(updated).toHaveCount(0)
    await scheduled.getByRole("button", { name: "Run history", exact: true }).click()
    await expect(scheduled.getByRole("heading", { name: "No runs yet" })).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    const response = await fetch(`${backend}/schedule`)
    const state = Schema.decodeUnknownSync(
      Schema.Struct({
        schedules: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            deleted: Schema.Boolean,
            definition: Schema.Struct({ name: Schema.String }),
          }),
        ),
      }),
    )(await response.json())
    for (const task of state.schedules.filter(
      (task) => !task.deleted && [name, edited].includes(task.definition.name),
    )) {
      await fetch(`${backend}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id: task.id }),
      })
    }
    await rm(directory, { recursive: true, force: true })
  }
})
