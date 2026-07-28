import { expect, test } from "bun:test"
import { ipcPort } from "../src/port"
import { success, type BrowserIpcRequest, type BrowserState } from "../src/protocol"

test("correlates out-of-order utility-process results", async () => {
  const sent: BrowserIpcRequest[] = []
  let receive: ((event: { data: unknown }) => void) | undefined
  const port = ipcPort({
    postMessage: (message) => sent.push(message),
    on: (_event, listener) => {
      receive = listener
    },
  })
  const first = port.send("ses_1", { op: "read_state" })
  const second = port.send("ses_2", { op: "read_state" })
  const state = (url: string): BrowserState => ({ url, title: "", visibleText: "", elements: [] })
  receive?.({ data: { type: "browser_result", id: sent[1].id, response: success(state("https://two.test")) } })
  receive?.({ data: { type: "browser_result", id: sent[0].id, response: success(state("https://one.test")) } })
  const firstResult = await first
  const secondResult = await second
  expect(firstResult.ok ? firstResult.result.url : "").toBe("https://one.test")
  expect(secondResult.ok ? secondResult.result.url : "").toBe("https://two.test")
})
