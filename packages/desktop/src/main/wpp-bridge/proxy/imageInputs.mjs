import { readImageDimensions } from "./imageDimensions.mjs";

export const MAX_IMAGE_INPUTS = 4;
export const MAX_IMAGE_INPUT_BYTES = 10 * 1024 * 1024;
export const SUPPORTED_IMAGE_INPUT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp"
]);

export function collectImageInputs(messages = []) {
  const images = [];

  for (const message of messages) {
    if (!Array.isArray(message?.content)) {
      continue;
    }

    for (const part of message.content) {
      if (part?.type !== "image_url") {
        continue;
      }

      const image = parseImageUrlPart(part, images.length + 1);
      images.push(image);

      if (images.length > MAX_IMAGE_INPUTS) {
        throw badImageInput(`Image input limit exceeded. V1 supports up to ${MAX_IMAGE_INPUTS} images per request.`);
      }
    }
  }

  return images;
}

export function imagePlaceholderText(part, index) {
  const url = imagePartUrl(part);

  if (!url) {
    return `[attached image ${index}]`;
  }

  const parsed = parseDataImageUrl(url);
  if (!parsed) {
    return `[attached image ${index}]`;
  }

  return `[attached image ${index}: ${parsed.mimeType}, ${parsed.sizeBytes} bytes]`;
}

function parseImageUrlPart(part, index) {
  const url = imagePartUrl(part);

  if (!url) {
    throw badImageInput("Image input is missing image_url.url.");
  }

  const parsed = parseDataImageUrl(url);
  if (!parsed) {
    throw badImageInput("Unsupported image input. V1 accepts only data:image/png, data:image/jpeg, and data:image/webp base64 URLs.");
  }

  if (!SUPPORTED_IMAGE_INPUT_TYPES.has(parsed.mimeType)) {
    throw badImageInput(`Unsupported image type ${parsed.mimeType}. V1 accepts PNG, JPEG, and WebP.`);
  }

  if (parsed.sizeBytes > MAX_IMAGE_INPUT_BYTES) {
    throw badImageInput(`Image ${index} is too large. V1 supports images up to ${MAX_IMAGE_INPUT_BYTES} bytes each.`);
  }

  return {
    id: `image_${index}`,
    name: `o1-code-image-${index}.${extensionForMimeType(parsed.mimeType)}`,
    mimeType: parsed.mimeType,
    data: parsed.base64,
    sizeBytes: parsed.sizeBytes,
    width: parsed.dimensions?.width ?? null,
    height: parsed.dimensions?.height ?? null
  };
}

function imagePartUrl(part) {
  if (typeof part?.image_url === "string") {
    return part.image_url;
  }

  return part?.image_url?.url;
}

function parseDataImageUrl(url) {
  const match = String(url || "").match(/^data:([^;,]+);base64,([\s\S]+)$/i);

  if (!match) {
    return null;
  }

  const mimeType = match[1].toLowerCase();
  const base64 = match[2].replace(/\s+/g, "");

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length === 0) {
    throw badImageInput("Image data URL must contain valid base64 data.");
  }

  const buffer = Buffer.from(base64, "base64");

  if (buffer.length === 0) {
    throw badImageInput("Image data URL must not be empty.");
  }

  return {
    mimeType,
    base64,
    sizeBytes: buffer.length,
    dimensions: readImageDimensions(buffer)
  };
}

function extensionForMimeType(mimeType) {
  if (mimeType === "image/jpeg") {
    return "jpg";
  }

  return mimeType.slice("image/".length);
}

function badImageInput(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.type = "invalid_image_input";
  return error;
}
