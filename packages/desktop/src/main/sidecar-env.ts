export function createSidecarEnv(
  config: () => string,
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(source).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
  )
  delete env.DEBUG
  if (platform === "linux") delete env.LD_PRELOAD
  env.OPENCODE_CONFIG_CONTENT = source.OPENCODE_CONFIG_CONTENT ?? config()
  return env
}
