import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import {
  addImage,
  appendText,
  captureScreenshot,
  navigate,
  pickElement,
  readSelectionText,
  type WebviewElement,
} from "./browser-actions"

function fakePrompt(initial: Prompt) {
  let prompt = initial
  return {
    capture: () => ({
      current: () => prompt,
      cursor: () => 0,
      set: (next: Prompt) => {
        prompt = next
      },
    }),
    parts: () => prompt,
  }
}

// Structural webview fake: the real type is HTMLElement-based, so build a loose
// record and cast. Methods under test are plain functions, no DOM required.
const webview = (overrides: Record<string, unknown>) => overrides as unknown as WebviewElement

describe("navigate", () => {
  test("dispatches to the matching webview method", () => {
    const calls: string[] = []
    const view = webview({
      goBack: () => calls.push("back"),
      goForward: () => calls.push("forward"),
      reload: () => calls.push("reload"),
      stop: () => calls.push("stop"),
    })
    navigate(view, "back")
    navigate(view, "forward")
    navigate(view, "reload")
    navigate(view, "stop")
    expect(calls).toEqual(["back", "forward", "reload", "stop"])
  })

  test("is a no-op without a webview", () => {
    expect(() => navigate(undefined, "reload")).not.toThrow()
  })
})

describe("captureScreenshot", () => {
  test("builds a PNG image part from the captured data URL", async () => {
    const dataUrl = "data:image/png;base64,AAAA"
    const part = await captureScreenshot(webview({ capturePage: () => Promise.resolve({ toDataURL: () => dataUrl }) }))
    expect(part).toMatchObject({ type: "image", mime: "image/png", dataUrl })
    expect(part?.filename).toMatch(/^browser-screenshot-\d+\.png$/)
  })

  test("returns undefined for non-PNG, missing, or failed captures", async () => {
    expect(
      await captureScreenshot(
        webview({ capturePage: () => Promise.resolve({ toDataURL: () => "data:image/jpeg;base64,AAAA" }) }),
      ),
    ).toBeUndefined()
    expect(await captureScreenshot(webview({ capturePage: () => Promise.reject(new Error("boom")) }))).toBeUndefined()
    expect(await captureScreenshot(undefined)).toBeUndefined()
  })
})

describe("readSelectionText", () => {
  test("returns the trimmed selection", async () => {
    expect(await readSelectionText(webview({ executeJavaScript: () => Promise.resolve("  hello  ") }))).toBe("hello")
  })

  test("returns empty string without executeJavaScript", async () => {
    expect(await readSelectionText(undefined)).toBe("")
    expect(await readSelectionText(webview({}))).toBe("")
  })
})

describe("pickElement", () => {
  test("resolves the injected-script result", async () => {
    let received = ""
    const picked = { tag: "button", label: "Save" }
    const result = await pickElement(
      webview({
        executeJavaScript: (code: string) => {
          received = code
          return Promise.resolve(picked)
        },
      }),
    )
    expect(result).toEqual(picked)
    expect(received).toContain("__cookieMonsterCancelPickElement")
  })

  test("returns undefined without executeJavaScript", async () => {
    expect(await pickElement(undefined)).toBeUndefined()
  })
})

describe("appendText / addImage", () => {
  test("appends text with a blank-line separator after non-empty content", () => {
    const prompt = fakePrompt([{ type: "text", content: "existing", start: 0, end: 8 }])
    appendText(prompt, "added")
    expect(prompt.parts()).toEqual([
      { type: "text", content: "existing", start: 0, end: 8 },
      { type: "text", content: "\n\nadded", start: 0, end: 7 },
    ])
  })

  test("appends text without a separator after empty content", () => {
    const prompt = fakePrompt([{ type: "text", content: "", start: 0, end: 0 }])
    appendText(prompt, "added")
    expect(prompt.parts()[1]).toMatchObject({ content: "added" })
  })

  test("appends an image part", () => {
    const prompt = fakePrompt([])
    const part = {
      type: "image" as const,
      id: "img-1",
      filename: "a.png",
      mime: "image/png",
      dataUrl: "data:image/png;base64,AA",
    }
    addImage(prompt, part)
    expect(prompt.parts()).toEqual([part])
  })
})
