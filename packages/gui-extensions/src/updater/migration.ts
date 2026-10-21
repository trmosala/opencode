import { Option, Schema } from "effect"

const Artifact = Schema.Struct({
  version: Schema.String,
  metadata: Schema.Struct({
    files: Schema.Record(Schema.String, Schema.Struct({ url: Schema.String })),
  }),
})

const decode = Schema.decodeUnknownOption(Artifact)

export function requiresStableMacInstaller(platform: string, channel: string) {
  return platform === "darwin" && channel === "beta"
}

// SAFETY: Update responses are untrusted; this boundary decodes Artifact before reading its fields.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- see SAFETY above
export function stableMacDownload(input: unknown, arch: string) {
  if (arch !== "arm64" && arch !== "x64") return undefined
  const artifact = Option.getOrUndefined(decode(input))
  const file = artifact?.metadata.files[`opencode-desktop-mac-${arch}.dmg`]

  return file && { version: artifact.version, url: file.url }
}

export function updatePolicy(name: string, platform: string, channel: string, packaged: boolean) {
  const branded = name === "CookieMonster"

  return {
    enabled:
      packaged && (branded ? ["darwin", "win32", "linux"].includes(platform) && channel === "prod" : channel !== "dev"),
    prerelease: branded,
  }
}
