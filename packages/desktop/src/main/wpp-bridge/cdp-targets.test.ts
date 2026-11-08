import { describe, expect, test } from "bun:test"
import type { WebContents } from "electron"
import { armTargetAttach, installInRootAndChildTargets, runTargetInstallers } from "./cdp-targets"

describe("runTargetInstallers", () => {
  test("runs installers in registration order before resume", async () => {
    const steps: string[] = []
    await runTargetInstallers(
      [
        async (sessionId) => {
          steps.push(`recorder:${sessionId}`)
        },
        async (sessionId) => {
          steps.push(`controller:${sessionId}`)
        },
        async (sessionId) => {
          steps.push(`network:${sessionId}`)
        },
      ],
      "iframe-1",
      async (sessionId) => {
        steps.push(`resume:${sessionId}`)
      },
    )
    expect(steps).toEqual(["recorder:iframe-1", "controller:iframe-1", "network:iframe-1", "resume:iframe-1"])
  })

  test("does not resume the root target", async () => {
    const steps: string[] = []
    await runTargetInstallers(
      [
        async () => {
          steps.push("install")
        },
      ],
      undefined,
      async () => {
        steps.push("resume")
      },
    )
    expect(steps).toEqual(["install"])
  })

  test("does not resume when a resume callback is omitted", async () => {
    const steps: string[] = []
    await runTargetInstallers(
      [
        async (sessionId) => {
          steps.push(`install:${sessionId}`)
        },
      ],
      "iframe-2",
    )
    expect(steps).toEqual(["install:iframe-2"])
  })
})

describe("armTargetAttach", () => {
  test("pauses child targets until every registered installer has run", async () => {
    const steps: string[] = []
    const listeners: Array<(...args: unknown[]) => void> = []
    const commands: Array<{ method: string; sessionId?: string; params?: unknown }> = []

    const contents = {
      debugger: {
        isAttached: () => true,
        attach: () => undefined,
        on: (_event: string, listener: (...args: unknown[]) => void) => {
          listeners.push(listener)
        },
        sendCommand: async (method: string, params?: unknown, sessionId?: string) => {
          commands.push({ method, params, sessionId })
          return {}
        },
      },
    } as unknown as WebContents

    await installInRootAndChildTargets(contents, async (sessionId) => {
      steps.push(`recorder:${sessionId ?? "root"}`)
    })
    await installInRootAndChildTargets(contents, async (sessionId) => {
      steps.push(`controller:${sessionId ?? "root"}`)
    })
    await installInRootAndChildTargets(contents, async (sessionId) => {
      steps.push(`network:${sessionId ?? "root"}`)
    })

    // Registering alone must not auto-attach — otherwise a child could resume early.
    expect(commands).toEqual([])
    expect(steps).toEqual([])

    await armTargetAttach(contents)

    expect(commands).toContainEqual({
      method: "Target.setAutoAttach",
      params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId: undefined,
    })
    expect(steps).toEqual(["recorder:root", "controller:root", "network:root"])

    const beforeChild = steps.length
    listeners[0]?.({}, "Target.attachedToTarget", { sessionId: "iframe-session" })

    // installers are async; wait until resume has been issued for the child.
    const started = Date.now()
    while (
      Date.now() - started < 1000 &&
      !commands.some(
        (command) => command.method === "Runtime.runIfWaitingForDebugger" && command.sessionId === "iframe-session",
      )
    ) {
      await Bun.sleep(5)
    }

    expect(steps.slice(beforeChild)).toEqual([
      "recorder:iframe-session",
      "controller:iframe-session",
      "network:iframe-session",
    ])
    expect(
      commands.some(
        (command) => command.method === "Runtime.runIfWaitingForDebugger" && command.sessionId === "iframe-session",
      ),
    ).toBe(true)
  })
})
