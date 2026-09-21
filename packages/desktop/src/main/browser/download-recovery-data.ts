import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { open, mkdir, unlink, realpath, stat, copyFile } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path"

export type DownloadRecovery = {
  version: 1
  url: string
  origin: string
  destination: string
  directoryDev: number
  directoryIno: number
  checkpoint: string
  offset: number
  total: number
  eTag: string
  lastModified: string
  sha256: string
}

export function recoveryURL(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8192 || !URL.canParse(value)) return false
  const url = new URL(value)
  return (
    !url.username &&
    !url.password &&
    !url.hash &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
}

export function recoveryData(value: unknown): DownloadRecovery | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const row = value as Record<string, unknown>
  if (
    row.version !== 1 ||
    !recoveryURL(row.url) ||
    !recoveryURL(row.origin) ||
    new URL(row.origin).origin !== row.origin ||
    typeof row.destination !== "string" ||
    !isAbsolute(row.destination) ||
    row.destination.length > 8192 ||
    typeof row.directoryDev !== "number" ||
    !Number.isSafeInteger(row.directoryDev) ||
    row.directoryDev < 0 ||
    typeof row.directoryIno !== "number" ||
    !Number.isSafeInteger(row.directoryIno) ||
    row.directoryIno < 0 ||
    typeof row.checkpoint !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.part$/.test(row.checkpoint) ||
    typeof row.offset !== "number" ||
    !Number.isSafeInteger(row.offset) ||
    row.offset <= 0 ||
    typeof row.total !== "number" ||
    !Number.isSafeInteger(row.total) ||
    row.total <= row.offset ||
    typeof row.eTag !== "string" ||
    !/^"[^"\r\n]{1,512}"$/.test(row.eTag) ||
    typeof row.lastModified !== "string" ||
    row.lastModified.length > 128 ||
    !Number.isFinite(Date.parse(row.lastModified)) ||
    typeof row.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.sha256)
  )
    return
  return {
    version: 1,
    url: row.url,
    origin: row.origin,
    destination: row.destination,
    directoryDev: row.directoryDev,
    directoryIno: row.directoryIno,
    checkpoint: row.checkpoint,
    offset: row.offset,
    total: row.total,
    eTag: row.eTag,
    lastModified: row.lastModified,
    sha256: row.sha256,
  }
}

export async function recoveryDestination(
  recovery: Pick<DownloadRecovery, "destination" | "directoryDev" | "directoryIno">,
) {
  const directory = dirname(recovery.destination)
  if ((await realpath(directory)) !== resolve(directory)) throw new Error("Download destination changed")
  const file = await stat(directory)
  if (!file.isDirectory() || file.dev !== recovery.directoryDev || file.ino !== recovery.directoryIno)
    throw new Error("Download destination changed")
}

// Chromium networking supplies authentication. Validate the actual response, not a separate
// probe that could succeed before a different response silently restarts the download.
export async function restoreDownload(
  root: string,
  recovery: DownloadRecovery,
  request: (url: string, options: RequestInit) => Promise<Response>,
  signal: AbortSignal,
  check: () => void,
  progress: (received: number) => void,
) {
  check()
  await recoveryDestination(recovery)
  if ((await realpath(root)) !== resolve(root)) throw new Error("Invalid recovery directory")
  const working = join(root, `${randomUUID()}.work`)
  if ((await copyDownloadPrefix(join(root, recovery.checkpoint), working, recovery.offset, true)) !== recovery.sha256) {
    await unlink(working)
    throw new Error("Partial download changed")
  }
  try {
    check()
    signal.throwIfAborted()
    const response = await request(recovery.url, {
      method: "GET",
      redirect: "error",
      credentials: "include",
      cache: "no-store",
      signal,
      headers: { Range: `bytes=${recovery.offset}-`, "If-Range": recovery.eTag, "Accept-Encoding": "identity" },
    })
    if (!validRangeResponse(response.status, response.headers, recovery) || !response.body) {
      await response.body?.cancel()
      throw new Error("Server cannot resume this download")
    }
    const output = await open(working, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0))
    const reader = response.body.getReader()
    try {
      let received = recovery.offset
      while (true) {
        const next = await reader.read()
        check()
        signal.throwIfAborted()
        if (next.done) break
        if (received + next.value.length > recovery.total) throw new Error("Download length changed")
        for (let written = 0; written < next.value.length; ) {
          const result = await output.write(next.value, written, next.value.length - written, received + written)
          if (!result.bytesWritten) throw new Error("Download write failed")
          written += result.bytesWritten
        }
        received += next.value.length
        progress(received)
      }
      if (received !== recovery.total) throw new Error("Download truncated")
      await output.sync()
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
      await output.close()
    }
    check()
    signal.throwIfAborted()
    await recoveryDestination(recovery)
    return await publishDownload(working, recovery, 1, () => {
      check()
      signal.throwIfAborted()
    })
  } finally {
    await unlink(working).catch(() => undefined)
  }
}

export async function publishDownload(
  source: string,
  recovery: Pick<DownloadRecovery, "destination" | "directoryDev" | "directoryIno">,
  first = 0,
  check = () => {},
) {
  // Never overwrite a chosen destination or a collision, including symlinks.
  const name = basename(recovery.destination)
  const ext = extname(name)
  for (let index = first; index <= 1000; index++) {
    await recoveryDestination(recovery)
    check()
    const destination = join(
      dirname(recovery.destination),
      index ? `${name.slice(0, name.length - ext.length)} (${index})${ext}` : name,
    )
    try {
      await copyFile(source, destination, constants.COPYFILE_EXCL)
      return destination
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error
    }
  }
  throw new Error("Download name limit reached")
}

// A checkpoint owns its bytes. Chromium may remove its original partial on cancellation.
// Never copy through a leaf or ancestor symlink, and never open the destination for overwrite.
export async function copyDownloadPrefix(source: string, destination: string, length: number, exact = false) {
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error("Invalid download length")
  if ((await realpath(source)) !== resolve(source)) throw new Error("Download source changed")
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const file = await input.stat()
    if (!file.isFile() || file.size < length || (exact && file.size !== length))
      throw new Error("Invalid partial download")
    const output = await open(destination, "wx", 0o600)
    try {
      const hash = createHash("sha256")
      const buffer = Buffer.alloc(64 * 1024)
      for (let offset = 0; offset < length; ) {
        const read = await input.read(buffer, 0, Math.min(buffer.length, length - offset), offset)
        if (!read.bytesRead) throw new Error("Partial download truncated")
        hash.update(buffer.subarray(0, read.bytesRead))
        for (let written = 0; written < read.bytesRead; ) {
          const next = await output.write(buffer, written, read.bytesRead - written, offset + written)
          if (!next.bytesWritten) throw new Error("Partial download write failed")
          written += next.bytesWritten
        }
        offset += read.bytesRead
      }
      await output.sync()
      return hash.digest("hex")
    } catch (error) {
      // Only a successfully opened, exclusively created file belongs to this operation.
      await output.close()
      await unlink(destination).catch(() => undefined)
      throw error
    } finally {
      await output.close()
    }
  } finally {
    await input.close()
  }
}

export async function downloadCheckpoint(root: string, source: string, offset: number) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  if ((await realpath(root)) !== resolve(root)) throw new Error("Invalid recovery directory")
  const checkpoint = `${randomUUID()}.part`
  const path = join(root, checkpoint)
  return { checkpoint, sha256: await copyDownloadPrefix(source, path, offset) }
}

export function validRangeResponse(
  status: number,
  headers: Headers,
  recovery: Pick<DownloadRecovery, "offset" | "total" | "eTag" | "lastModified">,
) {
  const end = recovery.total - 1
  return (
    status === 206 &&
    headers.get("content-range") === `bytes ${recovery.offset}-${end}/${recovery.total}` &&
    headers.get("content-length") === String(end - recovery.offset + 1) &&
    headers.get("etag") === recovery.eTag &&
    headers.get("last-modified") === recovery.lastModified &&
    [null, "identity"].includes(headers.get("content-encoding"))
  )
}
