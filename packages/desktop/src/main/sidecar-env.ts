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

// A user-supplied OPENCODE_CONFIG_CONTENT replaces the bundled blob. If it defines the cookiemonster provider, that
// provider still needs this launch's proxy token or every WPP turn is refused.
export function withProxyToken(content: string, token: string) {
  const parsed = parseJson(content)
  const provider = parsed?.provider?.cookiemonster
  if (!provider || typeof provider !== "object") return content
  return JSON.stringify({
    ...parsed,
    provider: { ...parsed.provider, cookiemonster: { ...provider, options: { ...provider.options, apiKey: token } } },
  })
}

function parseJson(content: string) {
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}
