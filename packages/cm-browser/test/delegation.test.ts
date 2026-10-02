import { describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { browserDelegation } from "../src/delegation"
import { ipcPort, type BrowserPort } from "../src/port"
import { failure, success, type Request } from "../src/protocol"

type Hook = NonNullable<Hooks["task.execute.scope"]>
const executionID = "af96a0d4-71d9-443b-aa8c-aa58c3392075"
const state = { tabID: "", url: "", title: "", visibleText: "", elements: [] }

function context() {
  const controller = new AbortController()
  const calls: string[] = []
  const cleanups: Array<() => Promise<void>> = []
  const input: Parameters<Hook>[0] = {
    executionID,
    parentSessionID: "parent",
    childSessionID: "child",
    browserTabIDs: ["one", "two"],
    abort: controller.signal,
    ask: async (permission) => {
      expect(cleanups).toHaveLength(1)
      expect(permission).toEqual({
        permission: "browser_delegate_tabs",
        patterns: ["one", "two"],
        always: [],
        metadata: { childSessionID: "child", tabIDs: ["one", "two"] },
      })
      calls.push("ask")
    },
  }
  const output: Parameters<Hook>[1] = {
    defer(cleanup) {
      cleanups.push(cleanup)
    },
    acknowledge() {
      calls.push("acknowledge")
    },
  }
  return { input, output, controller, cleanups, calls }
}

describe("browser task delegation", () => {
  test("registers cleanup first, asks exact IDs, grants, then acknowledges", async () => {
    const call = context()
    const sent: Request[] = []
    const port: BrowserPort = {
      send: async (sessionID, request, signal) => {
        expect(sessionID).toBe("parent")
        expect(call.cleanups).toHaveLength(1)
        sent.push(request)
        if (request.op === "grant_tabs") {
          expect(signal).toBe(call.controller.signal)
          expect(call.calls).toEqual(["ask"])
          return success({ ...state, delegation: { executionID, active: true } })
        }
        expect(signal).not.toBe(call.controller.signal)
        expect(signal?.aborted).toBe(false)
        return success({ ...state, delegation: { executionID, active: false } })
      },
    }
    await browserDelegation(port)(call.input, call.output)
    expect(call.calls).toEqual(["ask", "acknowledge"])
    call.controller.abort()
    for (const cleanup of call.cleanups) await cleanup()
    expect(sent).toEqual([
      { op: "grant_tabs", executionID, childSessionID: "child", tabIDs: ["one", "two"] },
      { op: "revoke_tabs", executionID },
    ])
  })

  for (const phase of ["pre-abort", "ask", "grant", "grant-abort"] as const) {
    test(`retains cleanup without acknowledgement after ${phase}`, async () => {
      const call = context()
      const sent: Request[] = []
      if (phase === "pre-abort") call.controller.abort()
      if (phase === "ask")
        call.input.ask = async () => {
          throw new Error("denied")
        }
      const port: BrowserPort = {
        send: async (_sessionID, request, signal) => {
          sent.push(request)
          if (request.op === "grant_tabs") {
            if (phase === "grant-abort") {
              call.controller.abort()
              return success({ ...state, delegation: { executionID, active: true } })
            }
            return failure("unavailable", "partial grant failed")
          }
          expect(signal?.aborted).toBe(false)
          return success({ ...state, delegation: { executionID, active: false } })
        },
      }
      await expect(browserDelegation(port)(call.input, call.output)).rejects.toThrow()
      expect(call.calls).not.toContain("acknowledge")
      expect(call.cleanups).toHaveLength(1)
      for (const cleanup of call.cleanups) await cleanup()
      expect(sent.at(-1)).toEqual({ op: "revoke_tabs", executionID })
      expect(sent).toHaveLength(phase === "grant" || phase === "grant-abort" ? 2 : 1)
    })
  }

  test("abort during permission wait never dispatches grant", async () => {
    const call = context()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const sent: Request[] = []
    call.input.ask = async () => {
      entered.resolve()
      await release.promise
    }
    const pending = browserDelegation({
      send: async (_session, request, signal) => {
        expect(signal?.aborted).toBe(false)
        sent.push(request)
        return success({ ...state, delegation: { executionID, active: false } })
      },
    })(call.input, call.output)
    await entered.promise
    call.controller.abort()
    release.resolve()
    await expect(pending).rejects.toThrow()
    for (const cleanup of call.cleanups) await cleanup()
    expect(sent).toEqual([{ op: "revoke_tabs", executionID }])
  })

  test("validates exact grant and revoke acknowledgements across the IPC boundary", async () => {
    for (const active of [true, false]) {
      for (const delegation of [
        undefined,
        null,
        [],
        {},
        { executionID, active: !active },
        { executionID: "other", active },
        { executionID, active: String(active) },
        { executionID, active, token: "unexpected" },
      ]) {
        const call = context()
        const listeners = new Set<(event: { data: unknown }) => void>()
        const port = ipcPort({
          on: (_event, listener) => {
            listeners.add(listener)
          },
          off: (_event, listener) => {
            listeners.delete(listener)
          },
          postMessage(message) {
            if (message.type !== "browser_request") return
            const grant = message.request.op === "grant_tabs"
            const response = {
              ok: true,
              result: { ...state, delegation: grant === active ? delegation : { executionID, active: grant } },
            }
            for (const listener of listeners) {
              listener({ data: { type: "browser_result", id: message.id, response } })
            }
          },
        })
        const pending = browserDelegation(port)(call.input, call.output)
        if (active) {
          await expect(pending).rejects.toThrow("acknowledgement")
          expect(call.calls).not.toContain("acknowledge")
          for (const cleanup of call.cleanups) await cleanup()
          continue
        }
        await pending
        for (const cleanup of call.cleanups) await expect(cleanup()).rejects.toThrow("acknowledgement")
      }
    }
  })

  test("does not hide revoke transport failures", async () => {
    const call = context()
    await browserDelegation({
      send: async (_session, request) =>
        request.op === "grant_tabs"
          ? success({ ...state, delegation: { executionID, active: true } })
          : failure("timeout", "revoke timed out"),
    })(call.input, call.output)
    for (const cleanup of call.cleanups) await expect(cleanup()).rejects.toThrow("revoke timed out")
  })
})
