import { describe, expect, test } from "bun:test"
import {
  collectImageInputs,
  MAX_IMAGE_HEIGHT,
  MAX_IMAGE_INPUT_BYTES,
  MAX_IMAGE_INPUTS,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_WIDTH,
} from "./imageInputs.mjs"

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
)

const image = (data = PNG_1X1, mimeType = "image/png") => ({
  type: "image_url",
  image_url: { url: `data:${mimeType};base64,${data.toString("base64")}` },
})

describe("collectImageInputs", () => {
  test("accepts more than four valid images", () => {
    const images = collectImageInputs([
      {
        role: "user",
        content: [image(), image(), image(), image(), image()],
      },
    ])

    expect(images).toHaveLength(5)
    expect(images.map((entry) => entry.id)).toEqual(["image_1", "image_2", "image_3", "image_4", "image_5"])
    expect(images[0]).toMatchObject({ width: 1, height: 1 })
  })

  test("rejects more than the supported image count", () => {
    expect(() =>
      collectImageInputs([{ role: "user", content: Array.from({ length: MAX_IMAGE_INPUTS + 1 }, () => image()) }]),
    ).toThrow(`supports up to ${MAX_IMAGE_INPUTS} images`)
  })

  test("rejects aggregate decoded bytes above the request limit", () => {
    const large = Buffer.alloc(MAX_IMAGE_INPUT_BYTES)
    PNG_1X1.copy(large)

    expect(() =>
      collectImageInputs([{ role: "user", content: [image(large), image(large), image(large), image(large), image(large)] }]),
    ).toThrow("decoded bytes per request")
  })

  test("rejects supported MIME types with unparseable headers", () => {
    expect(() => collectImageInputs([{ role: "user", content: [image(Buffer.from("not a png"))] }])).toThrow(
      "content is unrecognized",
    )
  })

  test("rejects data whose declared MIME type disagrees with its signature", () => {
    expect(() =>
      collectImageInputs([{ role: "user", content: [image(PNG_1X1, "image/jpeg")] }]),
    ).toThrow("content is image/png")
  })

  test("rejects non-canonical base64", () => {
    const part = image()
    part.image_url.url = part.image_url.url.slice(0, -1)
    expect(() => collectImageInputs([{ role: "user", content: [part] }])).toThrow("valid base64 data")
  })

  test("rejects excessive width, height, and total pixels", () => {
    expect(() =>
      collectImageInputs([{ role: "user", content: [image(pngHeader(MAX_IMAGE_WIDTH + 1, 1))] }]),
    ).toThrow("resolution is too large")
    expect(() =>
      collectImageInputs([{ role: "user", content: [image(pngHeader(1, MAX_IMAGE_HEIGHT + 1))] }]),
    ).toThrow("resolution is too large")
    expect(() =>
      collectImageInputs([{ role: "user", content: [image(pngHeader(8000, Math.floor(MAX_IMAGE_PIXELS / 8000) + 1))] }]),
    ).toThrow("resolution is too large")
  })
})

function pngHeader(width, height) {
  const buffer = Buffer.alloc(24)
  Buffer.from("\x89PNG\r\n\x1a\n", "latin1").copy(buffer)
  Buffer.from("IHDR").copy(buffer, 12)
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}
