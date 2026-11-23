import { expect, spyOn, test } from "bun:test"
import { BrowserWindow, dialog } from "electron"
import { confirmDownload, downloadLabel, downloadRule } from "./transfer-permissions"
import type { BrowserRegistration } from "./registry"

const tab = (transferGuarded: boolean) =>
  ({ transferGuarded, contents: { getURL: () => "https://page.example/app" } }) as unknown as BrowserRegistration

test("download labels drop queries and bound data and oversized URLs", () => {
  expect(downloadLabel("https://files.example/a/report.pdf?token=secret#x")).toBe("https://files.example/a/report.pdf")
  const data = `data:application/octet-stream;base64,${"A".repeat(5_000_000)}`
  const label = downloadLabel(data)
  expect(label.startsWith("data:application/octet-stream;base64,AAAA")).toBe(true)
  expect(label.length).toBe(200)
  expect(label.endsWith("…")).toBe(true)
  expect(downloadLabel(`https://files.example/${"x".repeat(1000)}`).length).toBe(200)
  // Never leave half of a surrogate pair before the ellipsis.
  expect(downloadLabel(`data:,${"a".repeat(193)}${"😀".repeat(10)}`)).toBe(`data:,${"a".repeat(193)}…`)
  expect(downloadLabel("blob:https://page.example/1234")).toBe("blob:https://page.example/1234")
})

test("download consent is asynchronous, shows the bounded URL and allows only on explicit approval", async () => {
  const prompt = spyOn(dialog, "showMessageBox")
  try {
    for (const [response, allowed] of [
      [1, true],
      [0, false],
    ] as const) {
      prompt.mockResolvedValueOnce({ response, checkboxChecked: false })
      const pending = confirmDownload(new BrowserWindow(), tab(true), "file.bin", `data:,${"x".repeat(100_000)}`)
      expect(pending).toBeInstanceOf(Promise)
      expect(await pending).toBe(allowed)
    }
    const options = prompt.mock.calls[0]?.[1] as { detail: string; defaultId: number; cancelId: number }
    expect(options.detail).toContain("https://page.example")
    expect(options.detail).toContain("file.bin")
    expect(options.detail.length).toBeLessThan(400)
    expect(options.defaultId).toBe(0)
    expect(options.cancelId).toBe(0)
  } finally {
    prompt.mockRestore()
  }
})

test("unguarded tabs keep the normal download path", () => {
  expect(downloadRule(tab(false))).toBe("allow")
})
