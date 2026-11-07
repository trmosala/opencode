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
