import "./styles.css"

type ViewState = "landing" | "thread"

const icon = (name: string, size = 18) => {
  const paths: Record<string, string> = {
    compose: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
    code: '<path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    spark: '<path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5Z"/>',
    panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    file: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    external: '<path d="M15 3h6v6M10 14 21 3M18 13v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h7"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
    eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
  }
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? paths.spark}</svg>`
}

const avatar = (label: string) => `<span class="avatar">${label}</span>`

const browserPage = () => `
  <div class="browser-site a-site">
    <nav><strong>Northstar</strong><span>Product</span><span>Customers</span><button>Get started</button></nav>
    <div class="a-site-hero"><small>SHIP WITH CONFIDENCE</small><h3>Software your team<br>can trust.</h3><p>Monitor every release, catch regressions early, and keep your customers moving.</p><button>Start building</button></div>
    <div class="a-site-proof"><span>Trusted by teams at</span><b>Arc</b><b>Vercel</b><b>Linear</b></div>
  </div>`

const browserPanel = () => `
  <aside class="context-pane">
    <header class="context-header">
      <div class="context-tabs"><button class="active" data-context-tab="browser">${icon("globe", 14)} Browser</button><button data-context-tab="changes">${icon("code", 14)} Changes <span>3</span></button></div>
      <button class="icon-button" title="Open externally">${icon("external", 15)}</button>
    </header>
    <section class="context-view browser-view active">
      <div class="browser-chrome">
        <div class="browser-controls"><span>‹</span><span>›</span>${icon("refresh", 12)}</div>
        <div class="address"><i></i> localhost:3000</div>
        <button>${icon("sliders", 13)}</button>
      </div>
      <div class="browser-canvas">${browserPage()}</div>
      <footer class="browser-footer"><span><i></i> Preview connected</span><span>1440 × 900</span></footer>
    </section>
    <section class="context-view changes-view">
      <div class="change-summary"><span>3 files changed</span><b>+28 −6</b></div>
      <button class="changed-file active">${icon("file", 14)} worker-pool.ts <span>M</span></button>
      <button class="changed-file">${icon("file", 14)} worker-pool.test.ts <span>M</span></button>
      <button class="changed-file">${icon("file", 14)} openaiCompat.mjs <span>M</span></button>
      <div class="diff-block"><div>worker-pool.ts <small>@@ -311,7 +311,12</small></div><pre><span>  if (authRequired) {</span><del>-   this.release(worker)</del><ins>+   await this.discard(worker)</ins><ins>+   this.authEpoch++</ins><span>  }</span></pre></div>
      <div class="check-row">${icon("check", 15)} <span><strong>42 checks passed</strong><small>Completed in 1.8s</small></span></div>
    </section>
  </aside>`

const stateButton = (state: ViewState) => `<button class="new-task" data-state="${state}">${icon("plus", 15)} <span>New task</span></button>`

function App(state: ViewState) {
  const landing = state === "landing"
  return `
    <main class="concept concept-a ${landing ? "is-landing" : "is-thread"}">
      <aside class="nav-pane">
        <div class="window-row"><div class="traffic-lights"><i></i><i></i><i></i></div><button class="icon-button">${icon("panel", 15)}</button></div>
        <div class="brand-row"><div class="brand-mark">CM</div><span><strong>CookieMonster</strong><small>Personal workspace</small></span></div>
        ${stateButton("landing")}
        <button class="nav-search">${icon("search", 15)} Search <kbd>⌘ K</kbd></button>
        <nav class="primary-nav"><button class="active">${icon("compose", 15)} Threads</button><button>${icon("folder", 15)} Projects</button></nav>
        <div class="nav-section"><p>Today</p><button class="${landing ? "" : "active"}" data-state="thread"><span>Fix authentication redirect</span><small>2m</small></button><button><span>Review browser permissions</span><small>1h</small></button></div>
        <div class="nav-section"><p>Yesterday</p><button><span>Update release workflow</span></button><button><span>Explore session recovery</span></button></div>
        <div class="nav-spacer"></div>
        <div class="account-row">${avatar("TM")}<span><strong>Tiisetso</strong><small>WPP connected</small></span><button>•••</button></div>
      </aside>

      <section class="main-pane">
        <header class="main-header"><button class="mobile-panel">${icon("panel")}</button><div><strong>${landing ? "New task" : "Fix authentication redirect"}</strong><small>${landing ? "CookieMonster" : "packages/desktop"}</small></div><button class="model-select">CM Opus 5.5 <span>⌄</span></button></header>
        ${landing ? `
          <div class="landing-content">
            <div class="landing-heading"><div class="assistant-badge">CM</div><p>Tuesday, 6 October</p><h1>What can I help you build?</h1><span>Describe the outcome. I can inspect the repo, edit files, run checks, and use the browser beside us.</span></div>
            <div class="hero-composer">
              <textarea name="message" aria-label="Message CookieMonster" placeholder="Ask CookieMonster to build, fix, or explain something"></textarea>
              <div><span><button>${icon("plus")}</button><button class="mode-chip">${icon("code", 14)} Code</button></span><button class="send" data-start-thread>${icon("send", 16)}</button></div>
            </div>
            <div class="starter-grid"><button><span>${icon("search", 17)}</span><strong>Trace a bug</strong><small>Follow a failure through the codebase</small></button><button><span>${icon("code", 17)}</span><strong>Build a feature</strong><small>Turn a clear brief into code</small></button><button><span>${icon("eye", 17)}</span><strong>Review changes</strong><small>Inspect the current branch</small></button></div>
          </div>` : `
          <div class="thread-content">
            <div class="user-message">The login window closes after SSO, but the app still shows "Authentication required". Can you trace why?</div>
            <article class="assistant-message"><div class="assistant-badge">CM</div><div><p>I'll trace the authentication state from the WPP worker through the bridge and into the renderer.</p><div class="activity-line">${icon("search", 14)} <span>Searched 8 files</span><small>1.2s</small></div><p>The login succeeds, but the stale worker remains in the pool. The next request reuses that worker before the persistent partition has refreshed its page state.</p><p>I'm discarding workers created before login and adding a regression test for the replay path.</p><button class="inline-change" data-open-changes>${icon("file", 15)} <span><strong>3 files changed</strong><small>+28 −6</small></span>${icon("chevron", 14)}</button></div></article>
          </div>
          <div class="bottom-composer"><div class="hero-composer"><textarea name="follow-up" aria-label="Send a follow-up" placeholder="Ask a follow-up"></textarea><div><span><button>${icon("plus")}</button><button class="mode-chip">${icon("code", 14)} Code</button></span><button class="send">${icon("send", 16)}</button></div></div><small>Review generated code before merging.</small></div>`}
      </section>
      ${browserPanel()}
    </main>`
}

const app = document.querySelector<HTMLDivElement>("#app")
if (!app) throw new Error("Prototype root not found")

const getState = (): ViewState => new URLSearchParams(location.search).get("state") === "thread" ? "thread" : "landing"

const render = () => {
  app.innerHTML = App(getState())
  bindInteractions()
}

const replaceState = (state: ViewState) => {
  const url = new URL(location.href)
  url.searchParams.delete("variant")
  url.searchParams.set("state", state)
  history.replaceState({}, "", url)
  render()
}

const bindInteractions = () => {
  document.querySelectorAll<HTMLButtonElement>("[data-state]").forEach((button) => button.addEventListener("click", () => replaceState(button.dataset.state as ViewState)))
  document.querySelectorAll<HTMLButtonElement>("[data-start-thread]").forEach((button) => button.addEventListener("click", () => replaceState("thread")))
  document.querySelectorAll<HTMLButtonElement>("[data-context-tab]").forEach((button) => button.addEventListener("click", () => {
    const pane = button.closest(".context-pane")
    pane?.querySelectorAll("[data-context-tab]").forEach((item) => item.classList.toggle("active", item === button))
    pane?.querySelector(".browser-view")?.classList.toggle("active", button.dataset.contextTab === "browser")
    pane?.querySelector(".changes-view")?.classList.toggle("active", button.dataset.contextTab === "changes")
  }))
  document.querySelectorAll<HTMLButtonElement>("[data-open-changes]").forEach((button) => button.addEventListener("click", () => {
    document.querySelector<HTMLButtonElement>('[data-context-tab="changes"]')?.click()
  }))
  document.querySelectorAll<HTMLTextAreaElement>("textarea").forEach((textarea) => textarea.addEventListener("input", () => {
    textarea.style.height = "0px"
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`
  }))
}

window.addEventListener("popstate", render)
render()
