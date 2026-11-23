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

// A user-supplied OPENCODE_CONFIG_CONTENT replaces the bundled blob, so the cookiemonster provider (from it, or merged
// from the on-disk seed) would lack this launch's proxy token and every WPP turn would be refused. Add the token, but
// only for the local proxy: a provider the user pointed at another host keeps its own key. Unparseable content
// (e.g. JSONC) is passed through unchanged.
export function withProxyToken(content: string, token: string) {
  const parsed = parseJson(content)
  if (!parsed || typeof parsed !== "object") return content
  const provider = parsed.provider?.cookiemonster ?? {}
  const baseURL = provider.options?.baseURL
  if (baseURL !== undefined && !isLoopbackURL(baseURL)) return content
  return JSON.stringify({
    ...parsed,
    provider: { ...parsed.provider, cookiemonster: { ...provider, options: { ...provider.options, apiKey: token } } },
  })
}

function isLoopbackURL(value: unknown) {
  return (
    typeof value === "string" &&
    URL.canParse(value) &&
    ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname)
  )
}

function parseJson(content: string) {
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}
