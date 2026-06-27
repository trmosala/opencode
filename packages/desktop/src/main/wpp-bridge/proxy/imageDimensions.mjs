// Zero-dep image dimension reader for PNG, JPEG, and WebP, parsed straight from the decoded
// image bytes (the Buffer we already build in imageInputs.mjs). Returns { width, height } in
// pixels, or null when the format/header can't be parsed — callers then fall back to a flat
// token estimate.
//
// We only read header bytes, never decode pixels, so this stays cheap and dependency-free
// (Node built-in Buffer only, per the repo's zero-runtime-dep rule).

export function readImageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return null;
  }

  return readPng(buffer) || readJpeg(buffer) || readWebp(buffer) || null;
}

function readPng(buffer) {
  // 8-byte PNG signature, then the IHDR chunk whose width/height are big-endian uint32s at
  // byte offsets 16 and 20.
  if (buffer.length < 24) {
    return null;
  }
  if (buffer.toString("latin1", 0, 8) !== "\x89PNG\r\n\x1a\n") {
    return null;
  }
  if (buffer.toString("latin1", 12, 16) !== "IHDR") {
    return null;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function readJpeg(buffer) {
  // JPEG starts with SOI (FFD8). Walk marker segments until a Start-Of-Frame marker, whose
  // payload carries height then width as big-endian uint16s (after a 1-byte precision field).
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 1 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    let marker = buffer[offset + 1];
    // Collapse fill runs of 0xFF between segments.
    while (marker === 0xff && offset + 2 < buffer.length) {
      offset += 1;
      marker = buffer[offset + 1];
    }
    offset += 2;

    // Standalone markers (SOI/EOI/RSTn) carry no length payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    if (offset + 1 >= buffer.length) {
      break;
    }
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2) {
      break;
    }

    // SOF markers that carry dimensions (exclude DHT 0xC4, JPG 0xC8, DAC 0xCC).
    const isSof = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 7 >= buffer.length) {
        break;
      }
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }

    offset += segmentLength;
  }

  return null;
}

function readWebp(buffer) {
  // RIFF container: "RIFF" <size> "WEBP" then a format chunk (VP8 / VP8L / VP8X).
  if (buffer.length < 16) {
    return null;
  }
  if (buffer.toString("latin1", 0, 4) !== "RIFF" || buffer.toString("latin1", 8, 12) !== "WEBP") {
    return null;
  }

  const format = buffer.toString("latin1", 12, 16);

  if (format === "VP8 ") {
    // Lossy: 14-bit width/height (little-endian) sit just past the 3-byte start code.
    if (buffer.length < 30) {
      return null;
    }
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }

  if (format === "VP8L") {
    // Lossless: after the 0x2F signature byte, 14 bits width-1 then 14 bits height-1 (LE).
    if (buffer.length < 25 || buffer[20] !== 0x2f) {
      return null;
    }
    const bits = buffer.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }

  if (format === "VP8X") {
    // Extended: 24-bit canvas width-1 then height-1 (LE) after a 4-byte flags/reserved field.
    if (buffer.length < 30) {
      return null;
    }
    const width = buffer.readUIntLE(24, 3) + 1;
    const height = buffer.readUIntLE(27, 3) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }

  return null;
}
