// Generated-media artifact capture — a SEPARATE channel from the model-response capture pipeline.
//
// WPP image/video generation is a typed async job (POST /v1/tools/.../results/.../resources), and
// the finished bytes are fetched by the page over a DIRECT presigned S3 GET that the page recorder's
// fetch/XHR patch never sees and that isWppModelRequest deliberately excludes. So artifacts are
// harvested here, off the main-process CDP witness, WITHOUT perturbing capture-verdict arbitration.
//
// Observed resolve request (confirmed live, reqid=1008):
//   GET https://wpp-ai-base-prd-persistentdatabucket.s3.eu-west-1.amazonaws.com
//       /resource/vertexai/gemini-3.1-flash-image/GEMINI_NANO_BANANA_2:1.0.0:<user>:<hash>/<uuid>.png
//       ?X-Amz-Algorithm=…&X-Amz-Signature=…&X-Amz-Security-Token=…&X-Amz-Expires=86400
//   content-type: image/png, access-control-allow-origin: *, and NO cookie/authorization header —
//   the signature in the query string fully authenticates it, so a plain unauthenticated GET in the
//   main process retrieves the bytes (as long as it runs before the ~24h presign expiry).
//
// Discriminator: generated artifacts live under the "/resource/" path prefix. Agent avatars sit on
// the SAME bucket under "/agents/" and "/projects/.../avatar/", so keying on "/resource/" is what
// separates a real generation from the roster thumbnails that also stream during a turn.

export type ArtifactResourceLike = {
  method?: string | null
  url?: string | null
}

export type ArtifactKind = "image" | "video"

export type WppArtifact = {
  url: string
  kind: ArtifactKind
  // Basename of the S3 key without query, e.g. "6e40023b-b006-42b1-b2bd-923d4968eb00.png".
  fileName: string
  extension: string
}

// Images first (the shipped v1 scope). Video rides the same /resource/ rail with a video extension,
// so the map is here to make the fast-follow a one-line change, but VIDEO is gated off by default.
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"])
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov"])

const RESOURCE_PATH_PREFIX = "/resource/"
const WPP_ARTIFACT_BUCKET = "wpp-ai-base-prd-persistentdatabucket"

// True when a witnessed request is a finished generated-media artifact fetch. Kept intentionally
// narrow: a presigned GET, on the WPP persistent bucket, under /resource/, with a media extension.
export function isWppArtifactRequest(request: ArtifactResourceLike, options: { includeVideo?: boolean } = {}): boolean {
  if (String(request.method || "GET").toUpperCase() !== "GET") return false
  return parseWppArtifact(request.url, options) !== null
}

// Parse a URL into a WppArtifact, or null when it is not a generated-media resource. Pure and
// side-effect free so it unit-tests against captured fixtures (success URL + avatar negatives).
export function parseWppArtifact(
  rawUrl: string | null | undefined,
  options: { includeVideo?: boolean } = {},
): WppArtifact | null {
  const url = safeUrl(rawUrl)
  if (!url) return null

  // Bucket may be virtual-hosted ("<bucket>.s3.<region>.amazonaws.com") or path-style
  // ("s3.<region>.amazonaws.com/<bucket>/…"); accept either so the predicate isn't brittle.
  const host = url.hostname.toLowerCase()
  const isVirtualHosted = host.startsWith(`${WPP_ARTIFACT_BUCKET}.s3.`) || host.startsWith(`${WPP_ARTIFACT_BUCKET}.s3-`)
  const isPathStyle = host.startsWith("s3.") && url.pathname.startsWith(`/${WPP_ARTIFACT_BUCKET}/`)
  if (!isVirtualHosted && !isPathStyle) return null

  const key = isPathStyle ? url.pathname.slice(`/${WPP_ARTIFACT_BUCKET}`.length) : url.pathname
  if (!key.startsWith(RESOURCE_PATH_PREFIX)) return null

  // Presigned only. A bare (unsigned) /resource/ URL wouldn't authenticate from the main process,
  // and its absence signals this isn't the self-contained artifact GET we can persist.
  if (!url.searchParams.has("X-Amz-Signature")) return null

  const fileName = decodeURIComponent(key.split("/").pop() || "")
  const extension = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : ""
  const kind = artifactKind(extension, options.includeVideo === true)
  if (!kind) return null

  return { url: url.toString(), kind, fileName, extension }
}

function artifactKind(extension: string, includeVideo: boolean): ArtifactKind | null {
  if (IMAGE_EXTENSIONS.has(extension)) return "image"
  if (includeVideo && VIDEO_EXTENSIONS.has(extension)) return "video"
  return null
}

function safeUrl(value: string | null | undefined): URL | null {
  if (!value) return null
  try {
    return new URL(String(value))
  } catch {
    return null
  }
}
