import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createServer } from "node:http"
import { chromium } from "@playwright/test"
import { build } from "vite"
import solid from "vite-plugin-solid"

test("cookie loaders retain their choice, inherit colour tokens, animate, and respect reduced motion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cm-loading-"))
  const browser = await chromium.launch()
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname
    if (pathname === "/") {
      response.setHeader("Content-Type", "text/html")
      response.end(
        '<link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
      )
      return
    }
    const file = Bun.file(join(directory, pathname))
    if (!(await file.exists())) {
      response.writeHead(404).end()
      return
    }
    response.setHeader("Content-Type", file.type)
    response.end(Buffer.from(await file.arrayBuffer()))
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Loader fixture server did not bind")
  try {
    await build({
      configFile: false,
      root: resolve("."),
      logLevel: "warn",
      plugins: [solid()],
      build: {
        outDir: directory,
        emptyOutDir: false,
        minify: false,
        lib: {
          entry: resolve("test-browser/cm-loading.fixture.tsx"),
          formats: ["es"],
          fileName: () => "fixture.js",
          cssFileName: "fixture",
        },
      },
    })
    const page = await browser.newPage()
    page.on("pageerror", (error) => console.error("Loader fixture:", error.message))
    page.on("console", (message) => {
      if (message.type() === "error") console.error("Loader fixture:", message.text())
    })
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.waitForSelector('#variants [data-loading-animation="flip-3d"]', { timeout: 5000 })
    const before = await page
      .locator("#random svg")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-loading-animation")))
    expect(new Set(before).size).toBeGreaterThan(1)
    await page.locator("#update").click()
    expect(
      await page
        .locator("#random svg")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-loading-animation"))),
    ).toEqual(before)
    expect(await page.locator("#random svg").first().getAttribute("aria-label")).toBe("Still waiting")
    expect(await page.locator("#random svg").first().getAttribute("aria-hidden")).toBe("false")
    expect(await page.locator("#stock [data-loading-animation]").count()).toBe(0)
    expect(await page.locator("#adapters [data-loading-animation]").count()).toBe(4)
    const ids = await page.locator("filter[id]").evaluateAll((nodes) => nodes.map((node) => node.id))
    expect(new Set(ids).size).toBe(ids.length)

    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('[data-slot="loading-still"]')).every(
        (image) => getComputedStyle(image).display === "block",
      ),
    )
    expect(
      await page
        .locator('[data-slot="loading-motion"]')
        .first()
        .evaluate((image) => getComputedStyle(image).display),
    ).toBe("none")
    expect(
      await page
        .locator("#adapters svg")
        .evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).animationName === "none")),
    ).toBe(true)
    const blue = await page.locator('[data-case="flip-3d"] svg').screenshot()
    const pixels = async (image: Buffer, colour: number[]) =>
      page.evaluate(
        async ({ image, colour }) => {
          const bitmap = await createImageBitmap(new Blob([new Uint8Array(image)], { type: "image/png" }))
          const canvas = document.createElement("canvas")
          canvas.width = bitmap.width
          canvas.height = bitmap.height
          const context = canvas.getContext("2d")!
          context.drawImage(bitmap, 0, 0)
          const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data
          bitmap.close()
          return Array.from({ length: bytes.length / 4 }, (_, i) => i * 4).filter((i) =>
            colour.every((value, channel) => Math.abs(bytes[i + channel] - value) < 4),
          ).length
        },
        { image: Array.from(image), colour },
      )
    expect(await pixels(blue, [17, 91, 177])).toBeGreaterThan(100)
    await page.locator("#theme").click()
    const light = await page.locator('[data-case="flip-3d"] svg').screenshot()
    expect(await pixels(light, [215, 225, 235])).toBeGreaterThan(100)
    expect(
      await page
        .locator("#random svg")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-loading-animation"))),
    ).toEqual(before)
    await page.emulateMedia({ reducedMotion: "no-preference" })
    const first = await page.locator('[data-case="flip-3d"] svg').screenshot({ animations: "allow" })
    // Allow the embedded SVG image to advance several projected vector frames.
    await page.waitForTimeout(220)
    const next = await page.locator('[data-case="flip-3d"] svg').screenshot({ animations: "allow" })
    expect(first.equals(next)).toBe(false)
    await page.screenshot({ path: join(directory, "preview.png"), fullPage: true })
  } finally {
    await browser.close()
    await new Promise<void>((done) => server.close(() => done()))
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
