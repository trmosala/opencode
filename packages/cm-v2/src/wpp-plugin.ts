import type { Plugin } from "@opencode/plugin/promise/plugin"

const runtimeID = process.env.CM_V2_RUNTIME_ID ?? ""
if (!runtimeID) throw new Error("CookieMonster runtime identity is unavailable")

export default {
  id: "cookiemonster.wpp",
  async setup(context) {
    await context.session.hook(
      "model.request",
      (event) => {
        // A WPP tab belongs to this process, never another backend using the same Session ID.
        Object.keys(event.headers)
          .filter((key) =>
            ["x-opencode-client", "x-opencode-runtime-id", "x-opencode-session-id"].includes(key.toLowerCase()),
          )
          .forEach((key) => delete event.headers[key])
        event.headers["x-opencode-client"] = "desktop"
        event.headers["x-opencode-runtime-id"] = runtimeID
        event.headers["x-opencode-session-id"] = event.sessionID
      },
      { providerID: "cookiemonster" },
    )
    await context.session.hook(
      "http.request",
      (event) => {
        // Route defaults are merged after model hooks; assert ownership on the final outgoing request too.
        event.request.headers.set("x-opencode-client", "desktop")
        event.request.headers.set("x-opencode-runtime-id", runtimeID)
        event.request.headers.set("x-opencode-session-id", event.sessionID)
      },
      { providerID: "cookiemonster" },
    )
  },
} satisfies Plugin
