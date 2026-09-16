import assert from "node:assert/strict"
import { once, getEventListeners } from "node:events"
import { createServer } from "node:http"
import { setTimeout } from "node:timers/promises"
import { BrowserWindow, WebContentsView } from "electron"
import type { Request, WriteRequest } from "@cookiemonster/cm-browser/protocol"
import { registerBrowserTab, setBrowserAgentEnabled, type BrowserRegistration } from "./registry"
import { routeBrowserRequest, type BrowserOperation } from "./router"

const html = `<!doctype html><title>Scroll/wait fixture</title>
<style>
body { margin: 0; height: 2400px; width: 2000px; }
#nested { position: absolute; left: 20px; top: 20px; width: 200px; height: 140px; overflow: auto; }
#content { width: 1000px; height: 1000px; }
#anchor { position: sticky; top: 0; left: 0; width: 100px; height: 50px; }
#clipped, #containing { height: 0; overflow: hidden; }
#containing { transform: translateZ(0); }
#escaped, #contained { position: fixed; left: 250px; top: 110px; }
#ready { display: none; position: fixed; left: 250px; top: 20px; }
#transparent { opacity: 0; }
#invisible { visibility: hidden; }
#outside { position: fixed; left: 10000px; top: 0; }
</style>
<div id="nested"><div id="content"><button id="anchor">Nested anchor</button></div></div>
<div id="ready" class="wait_ready primary">Dynamic ready</div>
<div id="transparent">Transparent</div><div id="invisible">Invisible</div><div id="outside">Outside viewport</div>
<div id="clipped"><button id="hidden">Clipped</button><button id="escaped">Fixed escape</button></div>
<div id="containing"><button id="contained">Fixed clipped</button></div>
<input id="password" type="password" value="synthetic-wait-secret" style="position:fixed;left:250px;top:60px">
<script>
window.wheels = [];
document.addEventListener("wheel", e => wheels.push({trusted:e.isTrusted, x:e.deltaX, y:e.deltaY}), {passive:true});
</script>`

export async function scrollWaitSmoke() {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE, "Only run through the isolated smoke runner")
  const stream = Promise.withResolvers<void>()
  const requested = Promise.withResolvers<void>()
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" })
    if (request.url === "/slow") {
      response.write("<!doctype html><title>Loading</title><body>Loading")
      requested.resolve()
      void stream.promise.then(() => response.end("<button>Destination</button>"))
      return
    }
    response.end(html)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}/`
  const win = new BrowserWindow({ show: false, width: 640, height: 480 })
  const view = new WebContentsView({
    webPreferences: { partition: "scroll-wait-fixture", sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 600, height: 400 })
  win.showInactive()
  const contents = view.webContents
  const tab: BrowserRegistration = {
    id: `scroll-wait-${contents.id}`,
    ownerID: win.id,
    sessionID: "scroll-wait",
    contents,
    revision: 0,
    agentAccess: true,
  }
  // Fixture registration uses the same epoch events as the production tab owner.
  contents.on("did-start-navigation", (_event, _url, _sameDocument, main) => {
    if (main) tab.revision++
  })
  contents.on("did-navigate-in-page", (_event, _url, main) => {
    if (main) tab.revision++
  })
  contents.on("dom-ready", () => {
    tab.revision++
  })
  const remove = registerBrowserTab(tab)
  const route = (request: Request, control: BrowserOperation = {}) =>
    routeBrowserRequest(
      { type: "browser_request", id: "fixture", sessionID: tab.sessionID, request },
      (destination) => new URL(destination).origin === new URL(url).origin,
      control,
    )
  const write = async (request: WriteRequest) => {
    const prepared = await route({ op: "prepare_write", request })
    assert(prepared.ok && prepared.result.context)
    return route({ ...request, context: prepared.result.context })
  }
  const load = async () => {
    await contents.loadURL(url)
    while (contents.isLoadingMainFrame()) await setTimeout(10)
  }
  const positions = (): Promise<{ x: number; y: number; nestedX: number; nestedY: number; trusted: boolean }> =>
    contents.executeJavaScript(
      "({x:scrollX,y:scrollY,nestedX:document.getElementById('nested').scrollLeft,nestedY:document.getElementById('nested').scrollTop,trusted:wheels.length>0 && wheels.every(e=>e.trusted)})",
    )
  const nativeSend = contents.debugger.sendCommand.bind(contents.debugger)
  let samples = 0
  contents.debugger.sendCommand = async (method, params) => {
    const response = await nativeSend(method, params)
    if (method === "Page.createIsolatedWorld") {
      await nativeSend("Runtime.evaluate", {
        contextId: response.executionContextId,
        expression: `(() => {
          if (globalThis.waitResources) return;
          globalThis.waitResources = { observers: 0, timers: new Set() };
          const Observer = IntersectionObserver, start = setTimeout, clear = clearTimeout;
          globalThis.IntersectionObserver = class extends Observer {
            constructor(callback) {
              super(entries => {
                for (const entry of entries) {
                  if (entry.target.dataset.waitMutation && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0)
                    entry.target.dataset.waitNotified = "true";
                }
                if (!waitResources.silent) callback(entries);
              });
              waitResources.observers++;
            }
            observe(el) {
              super.observe(el);
              // Fixture-only mutation after selector capture, before the real Chromium notification.
              if (el.dataset.waitMutation) queueMicrotask(() => {
                if (el.dataset.waitMutation === "class") el.removeAttribute("class");
                else el.id = "changed";
                el.style.display = "block";
              });
            }
            disconnect() { super.disconnect(); waitResources.observers--; }
          };
          globalThis.setTimeout = (callback, delay) => {
            const id = start(() => { waitResources.timers.delete(id); callback(); }, delay);
            waitResources.timers.add(id);
            return id;
          };
          globalThis.clearTimeout = id => { waitResources.timers.delete(id); clear(id); };
        })()`,
      })
    }
    if (params?.contextId && params?.expression?.includes("querySelectorAll")) {
      samples++
      const resources = await nativeSend("Runtime.evaluate", {
        contextId: params.contextId,
        expression: "({ observers: waitResources.observers, timers: waitResources.timers.size })",
        returnByValue: true,
      })
      assert.deepEqual(resources.result.value, { observers: 0, timers: 0 }, "probe releases native resources")
    }
    return response
  }
  const snapshot = async () => {
    const response = await route({ op: "read_state", tabID: tab.id })
    assert(response.ok)
    assert(!JSON.stringify(response).includes("synthetic-wait-secret"))
    return response.result
  }
  try {
    await load()
    const regressions: string[] = []
    for (const selector of [
      'body:has(input[type="password"][value^="s"])',
      'body:has(input[type="password"][value^="wrong"])',
      'input[value^="s"]',
      'input[value^="wrong"]',
      'input[value^="s"] + script',
      'body input[value^="s"]',
      '[type="password"]',
      ":is(#password)",
      "#password:valid",
      "#pass\\77 ord",
      "#password,body",
      "#password > span",
    ]) {
      const settled = Promise.withResolvers<void>()
      const response = await route(
        { op: "wait_for_element", tabID: tab.id, selector, timeoutMs: 300 },
        {
          onSettled: (operation) => {
            void operation.finally(() => settled.resolve())
          },
        },
      )
      await settled.promise
      if (response.ok || response.code !== "bad_request" || response.error !== "Invalid CSS selector.")
        regressions.push(`${selector}: ${response.ok ? "success" : response.code}`)
    }
    assert.equal(samples, 0, "unsupported selectors never reach a DOM probe")
    for (const [selector, visible] of [
      ["#escaped", true],
      ["#contained", false],
    ] as const) {
      const settled = Promise.withResolvers<void>()
      const response = await route(
        { op: "wait_for_element", tabID: tab.id, selector, timeoutMs: 500 },
        {
          onSettled: (operation) => {
            void operation.finally(() => settled.resolve())
          },
        },
      )
      await settled.promise
      if (visible ? !response.ok : response.ok || response.code !== "timeout")
        regressions.push(`${selector}: ${response.ok ? "success" : response.code}`)
    }
    assert.deepEqual(regressions, [], "selector oracle / Chromium clipping regressions")
    console.log("PASS rejected attribute oracle and selector bypasses; fixed escape and containing-block clip")
    const membership: string[] = []
    for (const [selector, attribute] of [
      [".wait_ready", "class"],
      ["#ready", "id"],
    ]) {
      await load()
      assert.equal(
        await contents.executeJavaScript(`(() => {
          const el = document.getElementById("ready");
          el.dataset.waitMutation = ${JSON.stringify(attribute)};
          return el.matches(${JSON.stringify(selector)}) && !el.checkVisibility();
        })()`),
        true,
        `${selector}: initially hidden match`,
      )
      const settled = Promise.withResolvers<void>()
      const response = await route(
        { op: "wait_for_element", tabID: tab.id, selector, timeoutMs: 500 },
        {
          onSettled: (operation) => {
            void operation.finally(() => settled.resolve())
          },
        },
      )
      await settled.promise
      assert.deepEqual(
        await contents.executeJavaScript(`(() => {
          const el = document.querySelector("[data-wait-mutation]");
          return { matches: el.matches(${JSON.stringify(selector)}), visible: el.checkVisibility(), notified: el.dataset.waitNotified };
        })()`),
        { matches: false, visible: true, notified: "true" },
        `${selector}: real intersecting notification after membership loss`,
      )
      console.log("Selector membership", selector, response.ok ? "success" : response.code)
      if (response.ok || response.code !== "timeout")
        membership.push(`${selector}: ${response.ok ? "unexpected success" : response.code}`)
    }
    assert.deepEqual(membership, [], "selector membership must hold at notification")
    console.log("PASS selector membership revalidated after class removal and ID change")
    await load()
    const state = await snapshot()
    const ref = state.elements.find((element) => element.text === "Nested anchor")?.ref
    assert(ref)
    const scrolled = await write({ op: "scroll", tabID: tab.id, ref, deltaX: 100, deltaY: 200, timeoutMs: 2000 })
    assert(scrolled.ok)
    assert.notEqual(scrolled.result.elements[0]?.ref, ref)
    const nested = await positions()
    assert(nested.nestedX > 0 && nested.nestedY > 0 && nested.x === 0 && nested.y === 0 && nested.trusted)
    console.log("PASS nested trusted wheel", JSON.stringify(nested))

    await contents.executeJavaScript("document.getElementById('nested').scrollTo(10000,10000)")
    const edge = await snapshot()
    const edgeRef = edge.elements.find((element) => element.text === "Nested anchor")?.ref
    assert(edgeRef)
    assert((await write({ op: "scroll", tabID: tab.id, ref: edgeRef, deltaX: 0, deltaY: 200, timeoutMs: 2000 })).ok)
    assert((await positions()).y > 0, "Chromium chains wheel input at a nested edge")
    await load()
    assert((await write({ op: "scroll", tabID: tab.id, deltaX: 80, deltaY: 180, timeoutMs: 2000 })).ok)
    const page = await positions()
    assert(page.x > 0 && page.y > 0 && page.nestedX === 0 && page.nestedY === 0)
    console.log("PASS viewport wheel", JSON.stringify(page))

    await load()
    await contents.executeJavaScript(
      "setTimeout(() => document.getElementById('ready').style.display='block', 180); undefined",
    )
    const dynamic = await route({ op: "wait_for_element", tabID: tab.id, selector: "#ready", timeoutMs: 2000 })
    assert(dynamic.ok && dynamic.result.visibleText.includes("Dynamic ready"))
    assert(
      !dynamic.result.elements.some((element) => element.text === "Dynamic ready"),
      "Noninteractive matches need not have refs",
    )
    for (const selector of ["div#ready.wait_ready.primary", ".wait_ready", "input"]) {
      assert((await route({ op: "wait_for_element", tabID: tab.id, selector, timeoutMs: 1000 })).ok, selector)
    }
    for (const selector of ["#absent", "#hidden", "#transparent", "#invisible", "#outside"]) {
      const settled = Promise.withResolvers<void>()
      const response = await route(
        { op: "wait_for_element", tabID: tab.id, selector, timeoutMs: 120 },
        {
          onSettled: (operation) => {
            void operation.finally(() => settled.resolve())
          },
        },
      )
      console.log("Negative selector", selector, response.ok ? "success" : response.code)
      assert(
        !response.ok && response.code === "timeout",
        `${selector}: ${response.ok ? "unexpected success" : response.code + ": " + response.error}`,
      )
      await settled.promise
    }
    for (const selector of ["[", '"); throw new Error("injected"); //']) {
      const response = await route({ op: "wait_for_element", tabID: tab.id, selector, timeoutMs: 2000 })
      assert(
        !response.ok && response.code === "bad_request" && response.error === "Invalid CSS selector.",
        response.ok ? "unexpected success" : response.code + ": " + response.error,
      )
    }
    // A page cannot monkeypatch the isolated probe or make it return field values.
    await contents.executeJavaScript(
      "document.querySelectorAll = () => { throw new Error('synthetic-wait-secret') }; undefined",
    )
    const password = await route({ op: "wait_for_element", tabID: tab.id, selector: "#password", timeoutMs: 1000 })
    assert(!JSON.stringify(password).includes("synthetic-wait-secret"))
    await load()

    for (const reason of ["cancel", "timeout"] as const) {
      const controller = new AbortController()
      const entered = Promise.withResolvers<void>()
      const held = Promise.withResolvers<void>()
      const settled = Promise.withResolvers<void>()
      const send = contents.debugger.sendCommand.bind(contents.debugger)
      let probes = 0
      let contextId = 0
      contents.debugger.sendCommand = async (method, params) => {
        if (method === "Page.createIsolatedWorld") {
          const value = await send(method, params)
          contextId = value.executionContextId
          await nativeSend("Runtime.evaluate", { contextId, expression: "waitResources.silent = true" })
          return value
        }
        if (params?.contextId && params?.expression?.includes("querySelectorAll")) {
          probes++
          const pending = send(method, params)
          const live = await nativeSend("Runtime.evaluate", {
            contextId,
            expression: "({ observers: waitResources.observers, timers: waitResources.timers.size })",
            returnByValue: true,
          })
          assert.deepEqual(live.result.value, { observers: 1, timers: 1 }, "observer is live before interruption")
          entered.resolve()
          const value = await pending
          await held.promise
          return value
        }
        return send(method, params)
      }
      try {
        const pending = route(
          { op: "wait_for_element", tabID: tab.id, selector: "#hidden", timeoutMs: reason === "timeout" ? 200 : 2000 },
          {
            signal: controller.signal,
            onSettled: (operation) => {
              void operation.finally(() => settled.resolve())
            },
          },
        )
        await entered.promise
        if (reason === "cancel") controller.abort()
        const response = await pending
        assert(!response.ok && response.code === (reason === "cancel" ? "cancelled" : "timeout"))
        assert.equal(contents.backgroundThrottling, false)
        const busy = await route({ op: "read_state", tabID: tab.id })
        assert(!busy.ok && busy.error.includes("Another operation"))
        held.resolve()
        await settled.promise
        assert.equal(contents.backgroundThrottling, true)
        assert.equal(probes, 1)
        assert.equal(getEventListeners(controller.signal, "abort").length, 0)
      } finally {
        held.resolve()
        controller.abort()
        contents.debugger.sendCommand = send
      }
    }
    const same = await route({ op: "wait_for_navigation", tabID: tab.id, url, timeoutMs: 1000 })
    assert(same.ok, "Already-loaded exact URL is level-triggered success")
    const waiting = route({ op: "wait_for_navigation", tabID: tab.id, url: url + "slow", timeoutMs: 2000 })
    assert.equal(tab.navigationAllowed, undefined)
    const loading = contents.loadURL(url + "slow")
    await requested.promise
    let completed = false
    void waiting.then(() => {
      completed = true
    })
    await setTimeout(120)
    assert.equal(completed, false, "Matching URL during loading is not success")
    stream.resolve()
    await loading
    const destination = await waiting
    assert(destination.ok && destination.result.url === url + "slow")

    await load()
    const stale = route({ op: "wait_for_element", tabID: tab.id, selector: "#absent", timeoutMs: 2000 })
    await contents.executeJavaScript("history.pushState({}, '', '#changed')")
    const changed = await stale
    assert(!changed.ok && changed.code === "unavailable")
    const revoked = route({ op: "wait_for_navigation", tabID: tab.id, url: url + "never", timeoutMs: 1000 })
    setBrowserAgentEnabled(false)
    setBrowserAgentEnabled(true)
    tab.agentAccess = true
    const denied = await revoked
    assert(!denied.ok && denied.code === "unavailable")
    assert.equal(tab.navigationAllowed, undefined)
    console.log(
      `PASS scroll/wait Chromium ${process.versions.chrome} Electron ${process.versions.electron}: nested/chained/viewport wheel, dynamic/clipped/invalid selectors, held cancel/expiry, loading/exact URL, source epoch and revocation`,
    )
  } finally {
    stream.resolve()
    remove()
    setBrowserAgentEnabled(true)
    contents.close({ waitForBeforeUnload: false })
    win.destroy()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}
