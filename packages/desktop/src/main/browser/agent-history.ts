import { randomUUID } from "node:crypto"
import { dialog, type BrowserWindow } from "electron"
import {
  failure,
  success,
  type HistoryRequest,
  type BrowserState,
  type Response,
} from "@cookiemonster/cm-browser/protocol"
import { nativeT } from "../native-translations"
import { browserAgentEnabled, browserTaskPaused, browserTaskEpoch } from "./registry"
import { browserPreferencesState, browserPreferencesRevision } from "./preferences"
import { historyRows } from "./browsing-data"
import { searchHistory } from "./history-search"

type Ticket = { id: string; url: string; expires: number; revision: number; sessionID: string }
const tickets = new WeakMap<BrowserWindow, Map<string, Ticket>>()
const pending = new WeakSet<BrowserWindow>()

export async function agentHistory(
  win: BrowserWindow,
  sessionID: string,
  request: HistoryRequest,
  open: (row: { url: string; title: string }) => string,
  signal?: AbortSignal,
): Promise<Response<BrowserState>> {
  signal?.throwIfAborted()
  const revision = browserPreferencesRevision()
  const taskEpoch = browserTaskEpoch(sessionID)
  const enabled = () =>
    !win.isDestroyed() &&
    !win.webContents.isDestroyed() &&
    browserAgentEnabled() &&
    !browserTaskPaused(sessionID) &&
    browserTaskEpoch(sessionID) === taskEpoch &&
    browserPreferencesState().agentHistory !== "never" &&
    browserPreferencesRevision() === revision
  if (!enabled()) return failure("access_denied", "Browser history access is disabled.")
  if (pending.has(win)) return failure("unavailable", "Another browser history request is awaiting approval.")
  const issued = tickets.get(win) ?? new Map<string, Ticket>()
  tickets.set(win, issued)
  issued.forEach((ticket, ref) => {
    if (ticket.expires <= Date.now() || ticket.revision !== revision) issued.delete(ref)
  })
  const lookup = () => {
    if (request.op !== "open_history") return undefined
    const ticket = issued.get(request.ref)
    if (!ticket || ticket.sessionID !== sessionID || ticket.expires <= Date.now() || ticket.revision !== revision)
      return undefined
    return historyRows().find((row) => row.id === ticket.id && row.url === ticket.url)
  }
  const row = lookup()
  if (request.op === "open_history" && !row)
    return failure("stale_ref", "History result expired or was deleted. Search again.")
  const deadline = Date.now() + 60_000
  if (request.op === "open_history" || browserPreferencesState().agentHistory === "ask") {
    pending.add(win)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60_000)
    try {
      const answer = await dialog.showMessageBox(win, {
        type: "question",
        message: nativeT(
          request.op === "search_history" ? "desktop.browser.history.search" : "desktop.browser.history.open",
        ),
        detail:
          request.op === "search_history"
            ? nativeT("desktop.browser.history.searchDetail", {
                query: request.query || nativeT("desktop.browser.history.all"),
                from:
                  request.from === undefined
                    ? nativeT("desktop.browser.history.all")
                    : new Date(request.from).toISOString(),
                to:
                  request.to === undefined
                    ? nativeT("desktop.browser.history.all")
                    : new Date(request.to).toISOString(),
                limit: request.limit,
              })
            : row!.url,
        buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.browser.allow")],
        defaultId: 0,
        cancelId: 0,
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      })
      if (answer.response !== 1) return failure("access_denied", "Browser history request declined.")
    } catch {
      return failure("unavailable", "Browser history approval unavailable.")
    } finally {
      clearTimeout(timer)
      pending.delete(win)
    }
  }
  signal?.throwIfAborted()
  if (Date.now() >= deadline || !enabled())
    return failure("access_denied", "Browser history access changed or expired.")
  const base = { tabID: "", url: "", title: "Browser history", visibleText: "", elements: [] }
  if (request.op === "search_history") {
    // Read after approval; deleted rows never survive in a result cache.
    const history = searchHistory(historyRows(), request).map((entry) => {
      const ref = randomUUID()
      issued.set(ref, { id: entry.id, url: entry.url, sessionID, revision, expires: Date.now() + 5 * 60_000 })
      return { ref, url: entry.url, title: entry.title.slice(0, 512), time: entry.time }
    })
    while (issued.size > 200) issued.delete(issued.keys().next().value!)
    return success({ ...base, history })
  }
  const current = lookup()
  if (!current) return failure("stale_ref", "History result expired or was deleted. Search again.")
  issued.delete(request.ref)
  return success({ ...base, tabID: open(current), url: current.url, title: current.title.slice(0, 512), opened: true })
}
