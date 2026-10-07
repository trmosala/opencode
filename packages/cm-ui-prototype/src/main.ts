import "./styles.css"
import { icon } from "./icon"

type ViewState = "landing" | "thread"

const avatar = (label: string) => `<span class="avatar">${label}</span>`

const browserPage = () => `
  <div class="browser-site a-site">
    <nav><strong>Northstar</strong><span>Product</span><span>Customers</span><button>Get started</button></nav>
    <div class="a-site-hero"><h3>Software your team<br>can trust.</h3><p>Monitor every release, catch regressions early, and keep your customers moving.</p><button>Start building</button></div>
  </div>`

const browserPanel = () => `
  <aside class="context-pane">
    <header class="context-header">
      <div class="context-tabs"><button class="active" data-context-tab="browser">${icon("browser", 14)} Browser</button><button data-context-tab="changes">${icon("git-diff", 14)} Changes</button></div>
      <button class="icon-button" aria-label="Open in default browser">${icon("arrow-square-out", 15)}</button>
    </header>
    <section class="context-view browser-view active">
      <div class="browser-chrome">
        <div class="browser-controls">${icon("arrow-left", 12)}${icon("arrow-right", 12)}${icon("arrow-clockwise", 12)}</div>
        <div class="address">localhost:3000</div>
        <button aria-label="Preview settings">${icon("sliders", 13)}</button>
      </div>
      <div class="browser-canvas">${browserPage()}</div>
    </section>
    <section class="context-view changes-view">
      <div class="change-summary"><span>3 files changed</span><b>+28 −6</b></div>
      <button class="changed-file active">${icon("file-code", 14)} worker-pool.ts</button>
      <button class="changed-file">${icon("file-code", 14)} worker-pool.test.ts</button>
      <button class="changed-file">${icon("file-code", 14)} openaiCompat.mjs</button>
      <div class="diff-block"><div>worker-pool.ts</div><pre><span>  if (authRequired) {</span><del>-   this.release(worker)</del><ins>+   await this.discard(worker)</ins><ins>+   this.authEpoch++</ins><span>  }</span></pre></div>
    </section>
  </aside>`

const stateButton = (state: ViewState) =>
  `<button class="new-task" data-state="${state}">${icon("note-pencil", 15)} <span>New task</span></button>`

function App(state: ViewState) {
  const landing = state === "landing"
  return `
    <main class="concept concept-a ${landing ? "is-landing" : "is-thread"}">
      <aside class="nav-pane">
        <div class="window-row"><div class="traffic-lights"><i></i><i></i><i></i></div><button class="icon-button" aria-label="Threads">${icon("sidebar-simple", 15)}</button></div>
        <div class="brand-row"><span><strong>CookieMonster</strong></span></div>
        ${stateButton("landing")}
        <button class="nav-search">${icon("magnifying-glass", 15)} Search</button>
        <nav class="primary-nav"><button class="active">${icon("chats", 15)} Threads</button><button>${icon("folder", 15)} Projects</button></nav>
        <div class="nav-section"><button class="${landing ? "" : "active"}" data-state="thread"><span>Fix authentication redirect</span></button><button><span>Review browser permissions</span></button></div>
        <div class="nav-section"><button><span>Update release workflow</span></button><button><span>Explore session recovery</span></button></div>
        <div class="nav-spacer"></div>
        <div class="account-row">${avatar("TM")}<span><strong>Tiisetso</strong></span><button aria-label="Account options">${icon("dots-three")}</button></div>
      </aside>

      <section class="main-pane">
        <header class="main-header"><button class="mobile-panel" aria-label="Threads">${icon("sidebar-simple")}</button><div><strong>${landing ? "New task" : "Fix authentication redirect"}</strong></div><button class="model-select">CM Opus 5.5 ${icon("caret-down", 12)}</button></header>
        ${
          landing
            ? `
          <div class="landing-content">
            <div class="landing-heading"><h1>What can I help you build?</h1></div>
            <div class="hero-composer">
              <textarea name="message" aria-label="Message" placeholder="Describe a task"></textarea>
              <div><span><button aria-label="Attach files">${icon("plus")}</button><button class="mode-chip">${icon("code", 14)} Code</button></span><button class="send" aria-label="Add message" data-start-thread>${icon("arrow-up", 16)}</button></div>
            </div>
            <div class="starter-grid"><button><span>${icon("magnifying-glass", 17)}</span><strong>Trace a bug</strong></button><button><span>${icon("code", 17)}</span><strong>Build a feature</strong></button><button><span>${icon("eye", 17)}</span><strong>Review changes</strong></button></div>
          </div>`
            : `
          <div class="thread-content">
            <div class="user-message">The login window closes after SSO, but the app still shows "Authentication required". Can you trace why?</div>
            <article class="assistant-message"><div class="assistant-badge">CM</div><div><p>The login succeeds, but the stale worker remains in the pool. The next request reuses that worker before the persistent partition has refreshed its page state.</p><p>Discard workers created before login and add a regression test for the replay path.</p><button class="inline-change" data-open-changes>${icon("git-diff", 15)} <span><strong>3 files changed</strong><small>+28 −6</small></span>${icon("caret-right", 14)}</button></div></article>
          </div>
          <div class="bottom-composer"><div class="hero-composer"><textarea name="follow-up" aria-label="Follow-up" placeholder="Ask a follow-up"></textarea><div><span><button aria-label="Attach files">${icon("plus")}</button><button class="mode-chip">${icon("code", 14)} Code</button></span><button class="send" aria-label="Add message">${icon("arrow-up", 16)}</button></div></div></div>`
        }
      </section>
      ${browserPanel()}
    </main>`
}

const app = document.querySelector<HTMLDivElement>("#app")
if (!app) throw new Error("Prototype root not found")

const getState = (): ViewState =>
  new URLSearchParams(location.search).get("state") === "thread" ? "thread" : "landing"

const media = window.matchMedia("(prefers-color-scheme: dark)")
const appearance = { scheme: "system" }

const applyScheme = () => {
  const mode = appearance.scheme === "system" ? (media.matches ? "dark" : "light") : appearance.scheme
  app.dataset.colorScheme = mode
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", mode === "dark" ? "#20211f" : "#fbfaf7")
}

media.addEventListener("change", () => {
  if (appearance.scheme === "system") applyScheme()
})

const render = () => {
  app.innerHTML = `
    <header class="prototype-bar">
      <strong>CM3 UI</strong>
      <span class="prototype-notice">Prototype. Messages stay local. Nothing is sent.</span>
      <label>Color scheme
        <span class="scheme-select">
          <select data-color-scheme-control>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
          ${icon("caret-down", 12)}
        </span>
      </label>
    </header>
    ${App(getState())}`
  const select = app.querySelector<HTMLSelectElement>("[data-color-scheme-control]")!
  select.value = appearance.scheme
  select.addEventListener("change", () => {
    if (select.value !== "system" && select.value !== "light" && select.value !== "dark") return
    appearance.scheme = select.value
    applyScheme()
  })
  applyScheme()
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
  document
    .querySelectorAll<HTMLButtonElement>("[data-state]")
    .forEach((button) => button.addEventListener("click", () => replaceState(button.dataset.state as ViewState)))
  document
    .querySelectorAll<HTMLButtonElement>("[data-start-thread]")
    .forEach((button) => button.addEventListener("click", () => replaceState("thread")))
  document.querySelectorAll<HTMLButtonElement>("[data-context-tab]").forEach((button) =>
    button.addEventListener("click", () => {
      const pane = button.closest(".context-pane")
      pane?.querySelectorAll("[data-context-tab]").forEach((item) => item.classList.toggle("active", item === button))
      pane?.querySelector(".browser-view")?.classList.toggle("active", button.dataset.contextTab === "browser")
      pane?.querySelector(".changes-view")?.classList.toggle("active", button.dataset.contextTab === "changes")
    }),
  )
  document.querySelectorAll<HTMLButtonElement>("[data-open-changes]").forEach((button) =>
    button.addEventListener("click", () => {
      document.querySelector<HTMLButtonElement>('[data-context-tab="changes"]')?.click()
    }),
  )
  document.querySelectorAll<HTMLTextAreaElement>("textarea").forEach((textarea) =>
    textarea.addEventListener("input", () => {
      textarea.style.height = "0px"
      textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`
    }),
  )
}

window.addEventListener("popstate", render)
render()
