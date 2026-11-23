import z from "zod"

const snapshot = z.object({
  name: z.string(),
  description: z.string().optional(),
  source: z.string(),
  revision: z.string(),
  content: z.string(),
  text: z.string(),
  location: z.string(),
  id: z.string(),
})

export const featuresRpc = {
  id: "cookiemonster.features",
  methods: {
    refresh: {
      input: z.object({
        selected: z.array(z.object({ name: z.string(), source: z.string(), revision: z.string() })).optional(),
      }),
      output: z.object({ skills: z.array(snapshot) }),
    },
    notify: {
      input: z.object({ sessionID: z.string(), name: z.string(), detail: z.string(), state: z.string() }),
      output: z.object({}),
    },
  },
  events: {
    schedule: { schema: z.object({ sessionID: z.string(), name: z.string(), detail: z.string(), state: z.string() }) },
  },
}

const model = z.object({ providerID: z.string(), id: z.string(), variant: z.string().optional() })
export const scheduleRuntimeRpc = {
  id: "cookiemonster.runtime",
  methods: {
    defaults: {
      input: z.object({ agent: z.string().optional(), model: model.optional() }),
      output: z.object({ agent: z.string(), model }),
    },
  },
  events: {},
}

// Since @opencode 2.3 plugins load in the background, and a call that reaches a Location before the CookieMonster
// plugin has activated there fails with `rpc.unavailable` instead of waiting. Upstream leaves that wait to callers.
export async function whenLoaded<T>(call: () => Promise<T>, deadline = Date.now() + 15_000): Promise<T> {
  const result = await call().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  if (result.ok) return result.value
  if (!isUnavailable(result.error) || Date.now() >= deadline) throw result.error
  await new Promise((resolve) => setTimeout(resolve, 50))
  return whenLoaded(call, deadline)
}

function isUnavailable(error: unknown) {
  return typeof error === "object" && error !== null && "type" in error && error.type === "rpc.unavailable"
}
