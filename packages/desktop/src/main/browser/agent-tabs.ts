import { randomUUID } from "node:crypto"
import { failure, success, type TabRequest, type BrowserState, type Response } from "@cookiemonster/cm-browser/protocol"
import {
  browserAgentEnabled,
  browserAgentEpoch,
  browserOperationBusy,
  browserRegistration,
  type BrowserRegistration,
  type TabLifecycleRequest,
} from "./registry"
import { browserInputFailure } from "./driver"
import { keepBrowserRendering } from "./rendering"
import { nativeT } from "../native-translations"

export class TabRecoveryRequired extends Error {}

// Narrow native seam: main captures owner/group authority; this handler owns tokens and settlement.
export type NativeTabAction = {
  owner: object
  target?: BrowserRegistration
  source?: BrowserRegistration
  check(): void
  confirm(signal: AbortSignal): Promise<boolean>
  run(check: () => void, signal: AbortSignal, deadline: number): string | undefined | Promise<string | undefined>
}

export function createTabHandler(resolve: (sessionID: string, request: TabRequest) => NativeTabAction | undefined) {
  const tokens = new Map<
    string,
    {
      sessionID: string
      request: TabRequest
      action: NativeTabAction
      tabs: BrowserRegistration[]
      check: () => void
      expires: number
    }
  >()
  const ownersBusy = new WeakSet<object>()
  return async (
    sessionID: string,
    input: TabLifecycleRequest,
    signal: AbortSignal,
    deadline: number,
  ): Promise<Response<BrowserState>> => {
    const empty = { tabID: "", url: "", title: "", visibleText: "", elements: [] }
    try {
      signal.throwIfAborted()
      if (Date.now() >= deadline) throw new Error("Expired")
      if (input.op === "prepare_tab") {
        for (const [token, entry] of tokens) if (entry.expires <= Date.now()) tokens.delete(token)
        const action = resolve(sessionID, input.request)
        if (!action) return failure("no_target", nativeT("desktop.browser.tabs.noTarget"))
        const tab = action.target
        const tabs = [...new Set([tab, action.source])].filter((entry): entry is BrowserRegistration => !!entry)
        const sources = tabs.map((entry) => ({
          tab: entry,
          contents: entry.contents,
          ownerID: entry.ownerID,
          url: entry.contents.getURL(),
          revision: entry.revision,
          access: entry.accessRevision,
          granted: entry.agentAccess,
        }))
        const epoch = browserAgentEpoch()
        const check = () => {
          action.check()
          if (
            !browserAgentEnabled() ||
            browserAgentEpoch() !== epoch ||
            sources.some(
              (source) =>
                browserRegistration(sessionID, source.tab.id) !== source.tab ||
                source.tab.contents !== source.contents ||
                source.tab.ownerID !== source.ownerID ||
                source.tab.revision !== source.revision ||
                source.tab.accessRevision !== source.access ||
                source.tab.agentAccess !== source.granted ||
                source.contents.getURL() !== source.url,
            ) ||
            (input.request.op === "select_tab" && tab && browserInputFailure(tab.contents))
          )
            throw new Error("Changed")
        }
        check()
        if (ownersBusy.has(action.owner) || tabs.some((tab) => browserOperationBusy.has(tab.id) || tab.leavePending))
          return failure("unavailable", nativeT("desktop.browser.tabs.busy"))
        // ponytail: 128 short-lived main-only approvals; evict oldest, never persist or replay.
        if (tokens.size >= 128) tokens.delete(tokens.keys().next().value!)
        const token = randomUUID()
        tokens.set(token, { sessionID, request: input.request, action, tabs, check, expires: Date.now() + 60_000 })
        return success({ ...empty, tabToken: token })
      }
      const entry = tokens.get(input.token)
      tokens.delete(input.token)
      if (
        !entry ||
        entry.sessionID !== sessionID ||
        entry.request.op !== input.op ||
        ("tabID" in entry.request && (!("tabID" in input) || input.tabID !== entry.request.tabID)) ||
        entry.expires <= Date.now()
      )
        return failure("access_denied", nativeT("desktop.browser.tabs.changed"))
      const { action } = entry
      const check = () => {
        signal.throwIfAborted()
        if (Date.now() >= deadline) throw new Error("Expired")
        entry.check()
      }
      check()
      const tabs = entry.tabs
      if (ownersBusy.has(action.owner) || tabs.some((tab) => browserOperationBusy.has(tab.id) || tab.leavePending))
        return failure("unavailable", nativeT("desktop.browser.tabs.busy"))
      // Reserve together before native consent can detach the active source, not during plugin approval.
      ownersBusy.add(action.owner)
      tabs.forEach((tab) => browserOperationBusy.add(tab.id))
      const releases: (() => void)[] = []
      try {
        tabs.forEach((tab) => releases.push(keepBrowserRendering(tab.contents)))
        check()
        const approved = await action.confirm(signal)
        check()
        if (!approved) return failure("access_denied", nativeT("desktop.browser.tabs.denied"))
        // No await between authority validation and the native mutation.
        const tabID = await action.run(check, signal, deadline)
        if (!tabID) return failure("cancelled", nativeT("desktop.browser.tabs.stay"))
        return success({ ...empty, tabResult: { op: input.op, tabID } })
      } finally {
        ownersBusy.delete(action.owner)
        tabs.forEach((tab) => browserOperationBusy.delete(tab.id))
        releases.forEach((release) => release())
      }
    } catch (error) {
      if (error instanceof TabRecoveryRequired)
        return failure("unavailable", nativeT("desktop.browser.tabs.recoveryRequired"))
      return failure("access_denied", nativeT("desktop.browser.tabs.changed"))
    }
  }
}
