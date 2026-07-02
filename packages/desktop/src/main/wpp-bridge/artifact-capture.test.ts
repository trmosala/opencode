import { describe, expect, test } from "bun:test"
import { isWppArtifactRequest, parseWppArtifact } from "./artifact-capture"

// Real presigned resolve URL captured live (reqid=1008): a "plain blue circle" generation. Query
// signature params are truncated here — only their presence matters to the predicate.
const GENERATED_IMAGE_URL =
  "https://wpp-ai-base-prd-persistentdatabucket.s3.eu-west-1.amazonaws.com" +
  "/resource/vertexai/gemini-3.1-flash-image" +
  "/GEMINI_NANO_BANANA_2%3A1.0.0%3Awppimagine_00ul9ruhf0vjtpsyj417%3A3f382a8d9264f4d8a2d08029243d852c7ac0bd7407fdb1bde63f948880bcdbf9" +
  "/6e40023b-b006-42b1-b2bd-923d4968eb00.png" +
  "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIAW3MECAX5TLLMTKPJ%2F20260701%2Feu-west-1%2Fs3%2Faws4_request" +
  "&X-Amz-Date=20260701T101629Z&X-Amz-Expires=86400&X-Amz-Security-Token=IQoJb3Jpxxx&X-Amz-Signature=b69a0fc9dfa1&X-Amz-SignedHeaders=host&x-id=GetObject"

// Agent avatar on the SAME bucket, captured the same session — the key negative. Lives under
// /agents/ (not /resource/), so it must never be mistaken for a generated artifact.
const AGENT_AVATAR_URL =
  "https://wpp-ai-base-prd-persistentdatabucket.s3.eu-west-1.amazonaws.com" +
  "/agents/2RLBBH7y7X1KSYEOe78Qv/JVl6b0Ne6NrXv3ZAqyUuc/avatars/JVl6b0Ne6NrXv3ZAqyUuc" +
  "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=1e92df60&X-Amz-SignedHeaders=host&x-id=GetObject"

// A project avatar (also same bucket, under /projects/.../avatar/) — the other negative shape.
const PROJECT_AVATAR_URL =
  "https://wpp-ai-base-prd-persistentdatabucket.s3.eu-west-1.amazonaws.com" +
  "/projects/7SvxOFruydqSDZe1NrpJo/agents/HXkbv8lD3zCp0V27onvVU/avatar/avatar.jpg" +
  "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=93c31103&X-Amz-SignedHeaders=host&x-id=GetObject"

// Tenant logo on GCS — different backend entirely, must be ignored.
const GCS_TENANT_LOGO_URL =
  "https://storage.googleapis.com/private-tenant-api-prd-one-wpp-com/4b3c8635-Ogilvy%20logo.png" +
  "?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=093fb122"

describe("parseWppArtifact", () => {
  test("parses the captured generated-image resource URL", () => {
    const artifact = parseWppArtifact(GENERATED_IMAGE_URL)
    expect(artifact).not.toBeNull()
    expect(artifact!.kind).toBe("image")
    expect(artifact!.fileName).toBe("6e40023b-b006-42b1-b2bd-923d4968eb00.png")
    expect(artifact!.extension).toBe("png")
  })

  test("rejects an agent avatar on the same bucket (under /agents/, not /resource/)", () => {
    expect(parseWppArtifact(AGENT_AVATAR_URL)).toBeNull()
  })

  test("rejects a project avatar (under /projects/.../avatar/)", () => {
    expect(parseWppArtifact(PROJECT_AVATAR_URL)).toBeNull()
  })

  test("rejects unrelated GCS tenant assets", () => {
    expect(parseWppArtifact(GCS_TENANT_LOGO_URL)).toBeNull()
  })

  test("rejects a /resource/ URL that is NOT presigned (no bytes we can self-fetch)", () => {
    expect(parseWppArtifact(
      "https://wpp-ai-base-prd-persistentdatabucket.s3.eu-west-1.amazonaws.com/resource/x/y/z.png",
    )).toBeNull()
  })

  test("video is gated off by default and opt-in via includeVideo", () => {
    const videoUrl = GENERATED_IMAGE_URL.replace("6e40023b-b006-42b1-b2bd-923d4968eb00.png", "clip.mp4")
    expect(parseWppArtifact(videoUrl)).toBeNull()
    const artifact = parseWppArtifact(videoUrl, { includeVideo: true })
    expect(artifact).not.toBeNull()
    expect(artifact!.kind).toBe("video")
    expect(artifact!.extension).toBe("mp4")
  })

  test("supports path-style S3 URLs", () => {
    const pathStyle =
      "https://s3.eu-west-1.amazonaws.com/wpp-ai-base-prd-persistentdatabucket" +
      "/resource/vertexai/x/y/out.webp?X-Amz-Signature=abc"
    const artifact = parseWppArtifact(pathStyle)
    expect(artifact).not.toBeNull()
    expect(artifact!.kind).toBe("image")
    expect(artifact!.extension).toBe("webp")
  })

  test("returns null for malformed URLs", () => {
    expect(parseWppArtifact("not a url")).toBeNull()
    expect(parseWppArtifact("")).toBeNull()
    expect(parseWppArtifact(null)).toBeNull()
    expect(parseWppArtifact(undefined)).toBeNull()
  })
})

describe("isWppArtifactRequest", () => {
  test("accepts a GET to the presigned generated-image resource URL", () => {
    expect(isWppArtifactRequest({ method: "GET", url: GENERATED_IMAGE_URL })).toBe(true)
  })

  test("rejects a non-GET even for a valid artifact URL", () => {
    expect(isWppArtifactRequest({ method: "POST", url: GENERATED_IMAGE_URL })).toBe(false)
  })

  test("rejects avatar GETs on the same bucket", () => {
    expect(isWppArtifactRequest({ method: "GET", url: AGENT_AVATAR_URL })).toBe(false)
    expect(isWppArtifactRequest({ method: "GET", url: PROJECT_AVATAR_URL })).toBe(false)
  })
})
