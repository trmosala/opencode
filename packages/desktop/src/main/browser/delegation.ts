import {
  browserIdentity,
  parseDelegationRequest,
  success,
  type BrowserState,
  type DelegationRequest,
  type Response,
} from "@cookiemonster/cm-browser/protocol"
import {
  browserAccessAllowed,
  browserAgentEnabled,
  browserRegistration,
  browserTabs,
  browserTabReserved,
  reserveBrowserTab,
  watchBrowserAccess,
  type BrowserRegistration,
} from "./registry"
import { browserOwnerScopeCurrent, type BrowserOwnerScope, type BrowserSessionResolver } from "./session-resolver"

export type BrowserAuthority = {
  signal?: AbortSignal
  token?: object
  check(): void
  trackNative?(operation: Promise<unknown>): void
  tabs(): BrowserRegistration[]
  resolve(tabID: string): BrowserRegistration | undefined
}

type Pin = {
  tab: BrowserRegistration
  contents: BrowserRegistration["contents"]
  ownerID: number
  ownerContext: string
  sessionID: string
  agentOwnerSessionID?: string
  accessRevision: number
  scope: BrowserOwnerScope
}
type Lease = {
  parent: string
  child?: string
  controller: AbortController
  state: "pending" | "active" | "revoked"
  pins: Pin[]
  cleanups: (() => void)[]
  reservations: (() => void)[]
  nativeOperations: Set<Promise<unknown>>
  expires: number
  timer?: ReturnType<typeof setInterval>
}

export const BROWSER_LEASE_MS = 30 * 60_000
export const MAX_BROWSER_EXECUTIONS = 4096

export function createBrowserDelegations(
  resolveSession?: BrowserSessionResolver,
  limits = { executions: MAX_BROWSER_EXECUTIONS, duration: BROWSER_LEASE_MS },
) {
  const executions = new Map<string, Lease>()
  const children = new Map<string, Lease>()
  let closed = false
  let exhausted = false
  const releaseReservations = (lease: Lease) => {
    if (lease.nativeOperations.size) return
    lease.reservations.splice(0).forEach((release) => release())
  }
  const trackNative = (lease: Lease, operation: Promise<unknown>) => {
    lease.nativeOperations.add(operation)
    const settled = () => {
      lease.nativeOperations.delete(operation)
      if (lease.state === "revoked") releaseReservations(lease)
    }
    void operation.then(settled, settled)
  }

  const revoke = (lease: Lease) => {
    if (lease.state === "revoked") return
    lease.state = "revoked"
    lease.controller.abort()
    clearInterval(lease.timer)
    lease.cleanups.splice(0).forEach((cleanup) => cleanup())
    if (lease.child && children.get(lease.child) === lease) children.delete(lease.child)
    lease.pins = []
    releaseReservations(lease)
  }
  const check = (lease: Lease) => {
    try {
      lease.controller.signal.throwIfAborted()
      if (closed || lease.state === "revoked" || Date.now() >= lease.expires || !browserAgentEnabled())
        throw new Error("Delegation expired")
      lease.pins.forEach((pin) => {
        const tab = pin.tab
        const scope = tab.ownerScope?.()
        if (
          browserRegistration(pin.sessionID, tab.id) !== tab ||
          tab.contents !== pin.contents ||
          tab.ownerID !== pin.ownerID ||
          tab.sessionID !== pin.sessionID ||
          tab.agentOwnerSessionID !== pin.agentOwnerSessionID ||
          tab.ownerContext?.() !== pin.ownerContext ||
          (tab.accessRevision ?? 0) !== pin.accessRevision ||
          !browserAccessAllowed(tab, tab.contents.getURL()) ||
          !scope ||
          scope.directory !== pin.scope.directory ||
          scope.projectID !== pin.scope.projectID ||
          scope.workspaceID !== pin.scope.workspaceID ||
          scope.serverURL !== pin.scope.serverURL ||
          scope.generation !== pin.scope.generation ||
          browserTabReserved(tab, lease)
        )
          throw new Error("Delegation authority changed")
      })
    } catch (error) {
      revoke(lease)
      throw error
    }
  }

  const run = async (
    parent: string,
    input: DelegationRequest,
    signal: AbortSignal,
    delivery: (check: () => void) => void,
  ): Promise<Response<BrowserState>> => {
    const request = parseDelegationRequest(input)
    if (!browserIdentity(parent) || !request) throw new Error("Invalid delegation")
    const prior = executions.get(request.executionID)
    if (prior && prior.parent !== parent) throw new Error("Execution belongs to another session")
    if (request.op === "revoke_tabs") {
      if (prior) revoke(prior)
      if (!prior && !closed && !exhausted) {
        if (executions.size >= limits.executions) exhausted = true
        else
          executions.set(request.executionID, {
            parent,
            controller: new AbortController(),
            state: "revoked",
            pins: [],
            cleanups: [],
            reservations: [],
            nativeOperations: new Set(),
            expires: 0,
          })
      }
      return acknowledgement(request.executionID, false)
    }
    if (
      closed ||
      exhausted ||
      prior ||
      !resolveSession ||
      parent === request.childSessionID ||
      children.has(request.childSessionID)
    )
      throw new Error("Delegation unavailable")
    if (executions.size >= limits.executions) {
      exhausted = true
      throw new Error("Delegation capacity reached")
    }
    const lease: Lease = {
      parent,
      child: request.childSessionID,
      controller: new AbortController(),
      state: "pending",
      pins: [],
      cleanups: [],
      reservations: [],
      nativeOperations: new Set(),
      expires: Date.now() + Math.min(BROWSER_LEASE_MS, Math.max(1, limits.duration)),
    }
    // Admission precedes all awaits. Revoke-before-grant and in-flight revoke can never resurrect this ID.
    executions.set(request.executionID, lease)
    children.set(request.childSessionID, lease)
    const abort = () => revoke(lease)
    signal.addEventListener("abort", abort, { once: true })
    try {
      signal.throwIfAborted()
      const nativeTabs = request.tabIDs.map((id) => {
        // Native membership only: never resolve a tab through the parent's delegation.
        const tab = browserRegistration(parent, id)
        const ownerContext = tab?.ownerContext?.()
        if (!tab || !ownerContext || !browserAccessAllowed(tab, tab.contents.getURL()))
          throw new Error("Native tab consent or owner scope unavailable")
        return {
          tab,
          contents: tab.contents,
          ownerID: tab.ownerID,
          ownerContext,
          sessionID: tab.sessionID,
          agentOwnerSessionID: tab.agentOwnerSessionID,
          accessRevision: tab.accessRevision ?? 0,
        }
      })
      nativeTabs.forEach(({ tab }) => {
        lease.reservations.push(reserveBrowserTab(tab, lease))
        lease.cleanups.push(watchBrowserAccess(tab, abort))
      })
      const bounded = AbortSignal.any([signal, lease.controller.signal, AbortSignal.timeout(3000)])
      await Promise.all(
        nativeTabs.map(({ tab }) => {
          if (tab.resolveOwnerScope) return tab.resolveOwnerScope(bounded)
          if (tab.ownerScopeReady) return tab.ownerScopeReady
          throw new Error("Native tab owner scope unavailable")
        }),
      )
      bounded.throwIfAborted()
      lease.pins = nativeTabs.map((native) => {
        const scope = native.tab.ownerScope?.()
        if (
          !scope ||
          !browserOwnerScopeCurrent(scope.generation) ||
          native.tab.contents !== native.contents ||
          native.tab.ownerID !== native.ownerID ||
          native.tab.sessionID !== native.sessionID ||
          native.tab.agentOwnerSessionID !== native.agentOwnerSessionID ||
          native.tab.ownerContext?.() !== native.ownerContext ||
          (native.tab.accessRevision ?? 0) !== native.accessRevision
        )
          throw new Error("Native tab owner scope unavailable")
        return {
          ...native,
          scope: { ...scope },
        }
      })
      lease.timer = setInterval(
        () => {
          try {
            check(lease)
          } catch {}
        },
        Math.min(50, limits.duration),
      )
      lease.timer.unref?.()
      check(lease)
      const scope = lease.pins[0].scope
      if (
        lease.pins.some(
          (pin) =>
            pin.ownerID !== lease.pins[0].ownerID ||
            pin.ownerContext !== lease.pins[0].ownerContext ||
            pin.scope.directory !== scope.directory ||
            pin.scope.projectID !== scope.projectID ||
            pin.scope.workspaceID !== scope.workspaceID ||
            pin.scope.serverURL !== scope.serverURL ||
            pin.scope.generation !== scope.generation,
        )
      )
        throw new Error("Mixed native owners")
      const parentSession = await resolveSession(parent, scope, bounded)
      check(lease)
      const childSession = await resolveSession(request.childSessionID, scope, bounded)
      bounded.throwIfAborted()
      if (
        parentSession.id !== parent ||
        childSession.id !== request.childSessionID ||
        childSession.parentID !== parent ||
        !browserIdentity(parentSession.projectID) ||
        parentSession.projectID !== childSession.projectID ||
        parentSession.projectID !== scope.projectID ||
        parentSession.workspaceID !== childSession.workspaceID ||
        parentSession.workspaceID !== scope.workspaceID ||
        parentSession.directory !== childSession.directory
      )
        throw new Error("Delegation requires a direct child in the same project")
      check(lease)
      lease.state = "active"
      delivery(() => check(lease))
      return acknowledgement(request.executionID, true)
    } catch (error) {
      revoke(lease)
      throw error
    } finally {
      signal.removeEventListener("abort", abort)
    }
  }

  const authority = (sessionID: string): BrowserAuthority => {
    const lease = children.get(sessionID)
    if (lease) {
      const requireActive = () => {
        check(lease)
        if (lease.state !== "active") throw new Error("Delegation not active")
      }
      return {
        token: lease,
        signal: lease.controller.signal,
        check: requireActive,
        trackNative: (operation) => trackNative(lease, operation),
        tabs: () => {
          requireActive()
          return lease.pins.map((pin) => pin.tab)
        },
        resolve: (tabID) => {
          requireActive()
          return lease.pins.find((pin) => pin.tab.id === tabID)?.tab
        },
      }
    }
    return {
      check: () => {
        if (closed) throw new Error("Sidecar closed")
      },
      tabs: () => browserTabs(sessionID).filter((tab) => !browserTabReserved(tab)),
      resolve: (tabID) => {
        const tab = browserRegistration(sessionID, tabID)
        return tab && !browserTabReserved(tab) ? tab : undefined
      },
    }
  }

  return {
    run,
    authority,
    cancel(parent: string, executionID: string) {
      const lease = executions.get(executionID)
      if (lease?.parent === parent) revoke(lease)
    },
    stop() {
      closed = true
      executions.forEach(revoke)
      executions.clear()
      children.clear()
    },
  }
}

function acknowledgement(executionID: string, active: boolean): Response<BrowserState> {
  return success({
    tabID: "",
    url: "",
    title: "",
    visibleText: "",
    elements: [],
    delegation: { executionID, active },
  })
}
