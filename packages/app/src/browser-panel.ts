export type BrowserTab = {
  connection?: "https" | "http" | "unknown" | "error"
  id: string
  openerID?: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  agentAccess: boolean
  loadFailed: boolean
  zoom?: number
  device?: boolean
  find?: { active: number; matches: number }
}

export type BrowserTransferRule = { origin: string; uploads: "ask" | "block"; downloads: BrowserPermission }

export type BrowserProfile = {
  loginOfferExclusions?: string[]
  transferRules?: BrowserTransferRule[]
  bookmarks?: BrowserBookmark[]
  history: { id?: string; url: string; title: string; time: number }[]
  credentials: { id: string; origin: string; username: string }[]
  rememberHistory: boolean
  vaultAvailable: boolean
  vaultStatus?: "locked" | "unlocking" | "unlocked"
  preferences?: BrowserPreferences
  downloadDirectory?: string
  sites?: { origin: string; camera: BrowserPermission; microphone: BrowserPermission }[]
  agentHosts?: readonly string[]
}

export type BrowserPermission = "ask" | "allow" | "block"
export type BrowserPreferences = {
  offerSaveLogins: boolean
  agentHistory: "never" | "ask" | "allow"
  webLinks: "browser" | "external"
  localLinks: "browser" | "external"
  agentEnabled: boolean
  showFullURL: boolean
  selectionScreenshots: boolean
  askDownloadLocation: boolean
  restoreTabs: boolean
}

export type BrowserBookmark = { id: string; url: string; title: string; pinned: boolean }

export type BrowserDownload = {
  id: string
  filename: string
  state: "saving" | "completed" | "cancelled" | "interrupted"
  canReveal?: boolean
  time?: number
  received?: number
  total?: number
  paused?: boolean
  canControl?: boolean
}
export type BrowserTabs = {
  sessionID: string
  activeID?: string
  tabs: BrowserTab[]
  downloads?: BrowserDownload[]
  profile?: BrowserProfile
  recentlyClosed?: { id: string; url: string; title: string; time: number }[]
}
export type BrowserBounds = { x: number; y: number; width: number; height: number }
export type BrowserShortcut = "address" | "new" | "reopen" | "close" | "reload" | "next" | "previous" | "find" | "print"
export type BrowserClearKind = "history" | "cache" | "cookies" | "passwords" | "downloads"
export type BrowserClearRange = "hour" | "day" | "week" | "month" | "all"

export function browserShortcut(input: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}): BrowserShortcut | undefined {
  if (!(input.ctrlKey || input.metaKey) || input.altKey) return
  const key = input.key.toLowerCase()
  if (key === "tab") return input.shiftKey ? "previous" : "next"
  if (input.shiftKey && key === "t") return "reopen"
  if (input.shiftKey) return
  if (key === "l") return "address"
  if (key === "t") return "new"
  if (key === "w") return "close"
  if (key === "r") return "reload"
  if (key === "f") return "find"
  if (key === "p") return "print"
}
export type BrowserCommand =
  | { op: "allow-login-offers"; origin: string }
  | { op: "transfer-rule"; rule: BrowserTransferRule; remove?: boolean }
  | { op: "open-link"; url: string; destination: "browser" | "external" }
  | { op: "bookmark-save"; url: string; title: string; pinned: boolean; id?: string }
  | { op: "bookmark-delete"; id: string }
  | { op: "bookmark-import" | "bookmark-export" }
  | { op: "clear-site"; tabID: string }
  | { op: "state" | "new" }
  | { op: "select" | "close" | "back" | "forward" | "reload" | "stop"; tabID: string }
  | { op: "navigate"; tabID: string; url: string }
  | { op: "access"; tabID: string; enabled: boolean }
  | { op: "find"; tabID: string; text: string; forward?: boolean; next?: boolean }
  | { op: "zoom"; tabID: string; factor: number }
  | { op: "device"; tabID: string; enabled: boolean }
  | { op: "print" | "save-login"; tabID: string }
  | { op: "fill-login"; tabID: string; id: string; field?: "username" | "password" }
  | { op: "forget-login"; id: string }
  | { op: "unlock-vault" | "lock-vault" }
  | { op: "import"; kind: "passwords" | "cookies" }
  | { op: "settings"; rememberHistory: boolean }
  | { op: "preferences"; values: Partial<BrowserPreferences> }
  | { op: "download-directory"; reset?: boolean }
  | { op: "reveal-download"; id: string }
  | { op: "download-control"; id: string; action: "pause" | "resume" | "cancel" }
  | { op: "forget-download" | "forget-history"; id: string }
  | { op: "open-history"; id: string }
  | { op: "reopen"; id?: string }
  | { op: "clear-selected"; kinds: BrowserClearKind[]; range: BrowserClearRange }
  | { op: "agent-host"; host: string; remove?: boolean }
  | { op: "site-permission"; origin: string; camera: BrowserPermission; microphone: BrowserPermission }
  | { op: "clear"; kind: "history" | "cache" | "cookies" | "passwords" | "downloads" }

export type BrowserSelection = {
  tag: string
  text: string
  role: string
  label: string
  id: string
  className: string
}

export type BrowserPanelPlatform = {
  linkContext?(sessionID: string | null, lease: string): Promise<void>
  onOpened?(callback: (sessionID: string) => void): () => void
  command(sessionID: string, command: BrowserCommand): Promise<BrowserTabs>
  viewport(input: { sessionID: string; lease: string; bounds: BrowserBounds | null }): Promise<void>
  selection(sessionID: string, tabID: string): Promise<string>
  pick(sessionID: string, tabID: string): Promise<BrowserSelection | undefined>
  screenshot(sessionID: string, tabID: string): Promise<string>
  subscribe(callback: (state: BrowserTabs) => void): () => void
  onShortcut(callback: (input: { sessionID: string; shortcut: BrowserShortcut }) => void): () => void
}
