import { createHash } from "node:crypto"
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detectImageMimeType, readImageDimensions } from "./imageDimensions.mjs"

export const MAX_IMAGE_INPUTS = 12
export const MAX_IMAGE_INPUT_BYTES = 10 * 1024 * 1024
export const MAX_IMAGE_INPUT_TOTAL_BYTES = 40 * 1024 * 1024
export const MAX_IMAGE_WIDTH = 8192
export const MAX_IMAGE_HEIGHT = 8192
export const MAX_IMAGE_PIXELS = 32_000_000
export const SUPPORTED_IMAGE_INPUT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"])

export function collectImageInputs(messages = []) {
  const images = []
  let totalBytes = 0

  for (const message of messages) {
    if (!Array.isArray(message?.content)) {
      continue
    }

    for (const part of message.content) {
      if (part?.type !== "image_url") {
        continue
      }

      if (images.length >= MAX_IMAGE_INPUTS) {
        throw badImageInput(`Image input limit exceeded. V1 supports up to ${MAX_IMAGE_INPUTS} images per request.`)
      }
      const image = parseImageUrlPart(part, images.length + 1)
      totalBytes += image.sizeBytes
      if (totalBytes > MAX_IMAGE_INPUT_TOTAL_BYTES) {
        throw badImageInput(
          `Image inputs are too large. V1 supports up to ${MAX_IMAGE_INPUT_TOTAL_BYTES} decoded bytes per request.`,
        )
      }
      images.push(image)
    }
  }

  return images
}

export function imagePlaceholderText(part, index) {
  const url = imagePartUrl(part)

  if (!url) {
    return `[attached image ${index}]`
  }

  const parsed = parseDataImageUrl(url)
  if (!parsed) {
    return `[attached image ${index}]`
  }

  const file = stashImage(parsed)
  return `[attached image ${index}: ${parsed.mimeType}, ${parsed.sizeBytes} bytes${file ? `, saved at ${file}` : ""}]`
}

// Only the latest user turn is pasted into WPP; earlier images survive only as placeholders. Every
// image is therefore also written, content-addressed, under OpenCode's temp directory
// (Global.Path.tmp, which agents may read without an external-directory prompt) so the agent can
// open any of them again with its read tool, one image per turn.
export function imageStashDir(env = process.env) {
  return env.O1_CODE_ATTACHMENT_DIR || join(tmpdir(), "opencode", "cm-attachments")
}

function stashImage(parsed) {
  if (!SUPPORTED_IMAGE_INPUT_TYPES.has(parsed.mimeType)) return null
  const dir = imageStashDir()
  const file = join(
    dir,
    `${createHash("sha256").update(parsed.buffer).digest("hex")}.${extensionForMimeType(parsed.mimeType)}`,
  )
  // A failed write only drops the path from the placeholder; it must never fail the turn.
  try {
    if (existsSync(file)) return file
    mkdirSync(dir, { recursive: true })
    // Write then rename so a crash never leaves a truncated file that existsSync would trust.
    const partial = `${file}.${process.pid}.partial`
    writeFileSync(partial, parsed.buffer)
    renameSync(partial, file)
    return file
  } catch {
    return null
  }
}

function parseImageUrlPart(part, index) {
  const url = imagePartUrl(part)

  if (!url) {
    throw badImageInput("Image input is missing image_url.url.")
  }

  const parsed = parseDataImageUrl(url)
  if (!parsed) {
    throw badImageInput(
      "Unsupported image input. V1 accepts only data:image/png, data:image/jpeg, and data:image/webp base64 URLs.",
    )
  }

  if (!SUPPORTED_IMAGE_INPUT_TYPES.has(parsed.mimeType)) {
    throw badImageInput(`Unsupported image type ${parsed.mimeType}. V1 accepts PNG, JPEG, and WebP.`)
  }

  if (parsed.detectedMimeType !== parsed.mimeType) {
    throw badImageInput(
      `Image ${index} content is ${parsed.detectedMimeType || "unrecognized"} but the data URL declares ${parsed.mimeType}.`,
    )
  }

  if (parsed.sizeBytes > MAX_IMAGE_INPUT_BYTES) {
    throw badImageInput(`Image ${index} is too large. V1 supports images up to ${MAX_IMAGE_INPUT_BYTES} bytes each.`)
  }

  if (!parsed.dimensions) {
    throw badImageInput(`Image ${index} has an invalid or unsupported ${parsed.mimeType} header.`)
  }

  if (
    parsed.dimensions.width > MAX_IMAGE_WIDTH ||
    parsed.dimensions.height > MAX_IMAGE_HEIGHT ||
    parsed.dimensions.width * parsed.dimensions.height > MAX_IMAGE_PIXELS
  ) {
    throw badImageInput(
      `Image ${index} resolution is too large. V1 supports up to ${MAX_IMAGE_WIDTH}x${MAX_IMAGE_HEIGHT} and ${MAX_IMAGE_PIXELS} pixels.`,
    )
  }

  return {
    id: `image_${index}`,
    name: `o1-code-image-${index}.${extensionForMimeType(parsed.mimeType)}`,
    mimeType: parsed.mimeType,
    data: parsed.base64,
    sizeBytes: parsed.sizeBytes,
    width: parsed.dimensions?.width ?? null,
    height: parsed.dimensions?.height ?? null,
  }
}

function imagePartUrl(part) {
  if (typeof part?.image_url === "string") {
    return part.image_url
  }

  return part?.image_url?.url
}

function parseDataImageUrl(url) {
  const match = String(url || "").match(/^data:([^;,]+);base64,([\s\S]+)$/i)

  if (!match) {
    return null
  }

  const mimeType = match[1].toLowerCase()
  const base64 = match[2].replace(/\s+/g, "")

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length === 0 || base64.length % 4 !== 0) {
    throw badImageInput("Image data URL must contain valid base64 data.")
  }

  const buffer = Buffer.from(base64, "base64")

  if (buffer.length === 0 || buffer.toString("base64") !== base64) {
    throw badImageInput("Image data URL must contain canonical base64 data.")
  }

  return {
    mimeType,
    base64,
    buffer,
    sizeBytes: buffer.length,
    detectedMimeType: detectImageMimeType(buffer),
    dimensions: readImageDimensions(buffer),
  }
}

function extensionForMimeType(mimeType) {
  if (mimeType === "image/jpeg") {
    return "jpg"
  }

  return mimeType.slice("image/".length)
}

function badImageInput(message) {
  const error = new Error(message)
  error.statusCode = 400
  error.type = "invalid_image_input"
  return error
}
