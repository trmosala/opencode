export const DESKTOP_NATIVE_LOCALES = [
  "en",
  "zh",
  "zht",
  "ko",
  "de",
  "es",
  "fr",
  "da",
  "ja",
  "pl",
  "ru",
  "uk",
  "bs",
  "ar",
  "no",
  "br",
  "th",
  "tr",
  "hi",
  "nl",
  "id",
  "vi",
  "it",
  "ur",
  "pa",
  "az",
  "fi",
  "sv",
  "am",
  "bg",
  "bn",
  "ca",
  "cs",
  "dv",
  "dz",
  "el",
  "et",
  "fa",
  "fo",
  "hr",
  "hu",
  "hy",
  "is",
  "ka",
  "km",
  "lo",
  "lt",
  "lv",
  "mk",
  "mn",
  "ms",
  "my",
  "ne",
  "ro",
  "si",
  "sk",
  "sl",
  "sq",
  "sr",
  "tg",
  "tk",
  "uz",
] as const

export type DesktopNativeLocale = (typeof DESKTOP_NATIVE_LOCALES)[number]

export const DESKTOP_NATIVE_LABELS: Record<DesktopNativeLocale, string> = {
  en: "English",
  zh: "简体中文",
  zht: "繁體中文",
  ko: "한국어",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
  da: "Dansk",
  ja: "日本語",
  pl: "Polski",
  ru: "Русский",
  uk: "Українська",
  bs: "Bosanski",
  ar: "العربية",
  no: "Norsk",
  br: "Português (Brasil)",
  th: "ไทย",
  tr: "Türkçe",
  hi: "हिन्दी",
  nl: "Nederlands",
  id: "Bahasa Indonesia",
  vi: "Tiếng Việt",
  it: "Italiano",
  ur: "اردو",
  pa: "پنجابی",
  az: "Azərbaycanca",
  fi: "Suomi",
  sv: "Svenska",
  am: "አማርኛ",
  bg: "Български",
  bn: "বাংলা",
  ca: "Català",
  cs: "Čeština",
  dv: "ދިވެހި",
  dz: "རྫོང་ཁ",
  el: "Ελληνικά",
  et: "Eesti",
  fa: "فارسی",
  fo: "Føroyskt",
  hr: "Hrvatski",
  hu: "Magyar",
  hy: "Հայերեն",
  is: "Íslenska",
  ka: "ქართული",
  km: "ខ្មែរ",
  lo: "ລາວ",
  lt: "Lietuvių",
  lv: "Latviešu",
  mk: "Македонски",
  mn: "Монгол",
  ms: "Bahasa Melayu",
  my: "မြန်မာ",
  ne: "नेपाली",
  ro: "Română",
  si: "සිංහල",
  sk: "Slovenčina",
  sl: "Slovenščina",
  sq: "Shqip",
  sr: "Српски",
  tg: "Тоҷикӣ",
  tk: "Türkmençe",
  uz: "Oʻzbekcha",
}

export const DESKTOP_NATIVE_LOCALE_TAGS: Record<DesktopNativeLocale, string> = {
  en: "en",
  zh: "zh-Hans",
  zht: "zh-Hant",
  ko: "ko",
  de: "de",
  es: "es",
  fr: "fr",
  da: "da",
  ja: "ja",
  pl: "pl",
  ru: "ru",
  uk: "uk",
  bs: "bs",
  ar: "ar",
  no: "nb-NO",
  br: "pt-BR",
  th: "th",
  tr: "tr",
  hi: "hi-IN",
  nl: "nl-NL",
  id: "id-ID",
  vi: "vi-VN",
  it: "it-IT",
  ur: "ur-PK",
  pa: "pa-Arab-PK",
  az: "az-Latn-AZ",
  fi: "fi-FI",
  sv: "sv-SE",
  am: "am-ET",
  bg: "bg-BG",
  bn: "bn-BD",
  ca: "ca-AD",
  cs: "cs-CZ",
  dv: "dv-MV",
  dz: "dz-BT",
  el: "el-GR",
  et: "et-EE",
  fa: "fa-IR",
  fo: "fo-FO",
  hr: "hr-HR",
  hu: "hu-HU",
  hy: "hy-AM",
  is: "is-IS",
  ka: "ka-GE",
  km: "km-KH",
  lo: "lo-LA",
  lt: "lt-LT",
  lv: "lv-LV",
  mk: "mk-MK",
  mn: "mn-MN",
  ms: "ms-MY",
  my: "my-MM",
  ne: "ne-NP",
  ro: "ro-RO",
  si: "si-LK",
  sk: "sk-SK",
  sl: "sl-SI",
  sq: "sq-AL",
  sr: "sr-Cyrl-RS",
  tg: "tg-Cyrl-TJ",
  tk: "tk-Latn-TM",
  uz: "uz-Latn-UZ",
}

export function detectDesktopNativeLocale(languages: readonly string[]): DesktopNativeLocale {
  for (const language of languages) {
    const source = locale(language)
    if (!source) continue
    if (["no", "nb", "nn"].includes(source.language)) return "no"
    const match = DESKTOP_NATIVE_LOCALES.find((candidate) => {
      const target = locale(DESKTOP_NATIVE_LOCALE_TAGS[candidate])
      return target?.language === source.language && target.script === source.script
    })
    if (match) return match
  }
  return "en"
}

export function desktopNativePluralCategories(locale: DesktopNativeLocale) {
  return new Intl.PluralRules(DESKTOP_NATIVE_LOCALE_TAGS[locale]).resolvedOptions().pluralCategories
}

function locale(value: string) {
  try {
    return new Intl.Locale(value).maximize()
  } catch {
    return undefined
  }
}

export const DESKTOP_NATIVE_ENGLISH = {
  "desktop.browser.tabs.create_tab": "Create one blank private tab?",
  "desktop.browser.tabs.select_tab": "Select this browser tab?",
  "desktop.browser.tabs.close_tab": "Close this browser tab?",
  "desktop.browser.tabs.createDetail":
    "Task: {{task}}\nTarget: one new about:blank tab\n\nThis creates and selects one private tab. No destination is opened and no page access is granted.",
  "desktop.browser.tabs.targetDetail":
    "Task: {{task}}\nTab: {{tab}}\n\nOnly this tab is affected. This approval does not grant page access. Closing still respects the page's unsaved-changes confirmation.",
  "desktop.browser.tabs.noTarget":
    "Open exactly one current task window in CookieMonster before using browser tab actions.",
  "desktop.browser.tabs.changed":
    "Browser tab approval expired or its task, owner or source changed. Request approval again.",
  "desktop.browser.tabs.denied": "Browser tab action consent was not granted.",
  "desktop.browser.tabs.busy": "Another browser operation is still running.",
  "desktop.browser.resources.title": "Unload inactive tab?",
  "desktop.browser.resources.detail":
    "Only the page URL and supported history will be retained. Other page state, including unsaved JavaScript work, cannot be restored. The page will reload only when you select the tab.",
  "desktop.browser.resources.unload": "Unload tab",
  "desktop.browser.resources.protected":
    "This tab cannot be unloaded while it is active, busy, protected, or contains unsaved or unsupported content.",
  "desktop.browser.tabs.unavailable": "Browser tab action unavailable.",
  "desktop.browser.tabs.stay": "The browser tab stayed open.",
  "desktop.browser.tabs.recoveryRequired":
    "Open this task's browser manually to restore its saved tabs and recently closed history before creating a tab.",
  "desktop.browser.driver.inputHeld":
    "Browser input may still be held after an interrupted action. Close this tab and open a new tab, then grant agent access again. Reloading or toggling access does not recover this tab.",
  "desktop.browser.driver.frameUnavailable": "Browser frame unavailable.",
  "desktop.browser.driver.contextUnavailable": "Browser context unavailable.",
  "desktop.browser.driver.probeUnavailable": "Browser element probe unavailable.",
  "desktop.browser.driver.invalidSelector": "Invalid CSS selector.",
  "desktop.browser.driver.viewportUnavailable": "Browser viewport unavailable.",
  "desktop.browser.driver.staleScrollRef": "Element ref is stale. Read browser state again.",
  "desktop.browser.driver.staleRef": "Element ref {{ref}} is stale. Read browser state again.",
  "desktop.browser.contacts.preview": "Fill these contact details?",
  "desktop.browser.contacts.detail":
    "Website: {{origin}}\nContact: {{label}}\n\n{{fields}}\n\nOnly the listed fields will be filled. The website can read these values. Nothing is submitted.",
  "desktop.browser.contacts.fill": "Fill fields",
  "desktop.browser.contacts.delete": "Delete contact {{label}}?",
  "desktop.browser.contacts.name": "Full name",
  "desktop.browser.contacts.given-name": "Given name",
  "desktop.browser.contacts.additional-name": "Additional name",
  "desktop.browser.contacts.family-name": "Family name",
  "desktop.browser.contacts.organization": "Organization",
  "desktop.browser.contacts.email": "Email",
  "desktop.browser.contacts.tel": "Phone",
  "desktop.browser.contacts.street-address": "Street address",
  "desktop.browser.contacts.address-line1": "Address line 1",
  "desktop.browser.contacts.address-line2": "Address line 2",
  "desktop.browser.contacts.address-line3": "Address line 3",
  "desktop.browser.contacts.address-level1": "State, province or region",
  "desktop.browser.contacts.address-level2": "City or locality",
  "desktop.browser.contacts.address-level3": "District",
  "desktop.browser.contacts.address-level4": "Neighborhood",
  "desktop.browser.contacts.postal-code": "Postal code",
  "desktop.browser.contacts.country": "Country code",
  "desktop.browser.account.title": "Saved account",
  "desktop.browser.account.entry":
    "Enter the website account for {{origin}}, not your Windows password. Existing passwords are never displayed. Nothing is saved until you confirm in CookieMonster.",
  "desktop.browser.account.confirm": "Save these account changes?",
  "desktop.browser.account.detail":
    "Website: {{origin}}\nAccount: {{username}}\nThis changes only the encrypted vault, not the password on the website.",
  "desktop.browser.offer.failed": "The login could not be saved. Unlock the vault and try saving it manually.",
  "desktop.browser.offer.save": "Save this submitted login?",
  "desktop.browser.offer.update": "Update this saved login?",
  "desktop.browser.offer.detail":
    "Website: {{origin}}\nAccount: {{username}}\nOnly save if this sign-in succeeded. The password stays in your encrypted vault.",
  "desktop.browser.offer.chooseAccount":
    "Choose the saved account to update for {{origin}}:\n\n{{accounts}}\n\nNothing is saved until you confirm.",
  "desktop.browser.offer.passwordDetail":
    "Website: {{origin}}\nAccount: {{username}}\nOnly save if this registration or password change succeeded. The password stays in your encrypted vault.",
  "desktop.browser.generation.title": "Generate and fill a new password?",
  "desktop.browser.generation.detail":
    "Website: {{origin}}\nLength: {{length}} (supported range: {{min}}-{{max}})\nCharacters: {{characters}}\nThis replaces only the new-password fields. Nothing is submitted or saved now. Submit the form yourself, then confirm saving only if the website accepted it. Keep the vault unlocked and this tab private; saving is not guaranteed if the page cannot be recognized.",
  "desktop.browser.generation.alphanumeric": "Uppercase and lowercase letters and digits",
  "desktop.browser.generation.symbols": "Uppercase and lowercase letters, digits and symbols",
  "desktop.browser.generation.fill": "Generate and fill",
  "desktop.browser.generation.settings": "Choose a length from 16 to 64 and a supported character option.",
  "desktop.browser.generation.offers":
    "Generation requires automatic save offers for this website. Enable save offers in browser settings and remove this website from exclusions before trying again. No preferences were changed.",
  "desktop.browser.generation.failed":
    "Password generation could not complete. Unlock the vault and use an unchanged active private tab with a secure, same-origin POST form and one or two visible new-password fields. Check the selected length against the site limits; pattern and custom-validation rules are unsupported. If filling already occurred, it cannot be recalled; nothing was saved by generation.",
  "desktop.browser.offer.notNow": "Not now",
  "desktop.browser.offer.updateButton": "Update",
  "desktop.browser.offer.never": "Never for this site",

  "desktop.browser.history.search": "Allow the agent to search browsing history?",
  "desktop.browser.history.searchDetail":
    "This searches saved visits across your browser profile.\nQuery: {{query}}\nFrom (UTC): {{from}}\nTo (UTC): {{to}}\nMaximum results: {{limit}}",
  "desktop.browser.history.open": "Open this history result in a new tab? Agent access will remain off.",
  "desktop.browser.history.all": "Any",

  "desktop.browser.transfer.download": "Allow this download from an agent-accessible tab?",
  "desktop.browser.transfer.downloadDetail": "Page: {{origin}}\nFile: {{filename}}\nDownload: {{url}}",
  "desktop.browser.transfer.upload": "Choose files to share with {{origin}}",
  "desktop.browser.transfer.frameUpload": "Allow file selection for this embedded page?",
  "desktop.browser.transfer.frameUploadDetail":
    "Top page: {{topOrigin}}\nReceiving embedded page: {{origin}}\nOnly files you choose will be shared. The receiving page can read and upload them immediately.",
  "desktop.browser.openInternal": "Open in CookieMonster",
  "desktop.browser.openExternal": "Open in default browser",
  "desktop.browser.importBookmarks": "Import bookmarks",
  "desktop.browser.exportBookmarks": "Export bookmarks",
  "desktop.browser.bookmarks": "Bookmarks",
  "desktop.browser.clearSite": "Clear browser data for {{origin}}?",
  "desktop.browser.clearSiteDetail":
    "This removes this origin’s stored data and cache, and Chromium clears cookies for its parent domain, including sibling subdomains. You may be signed out. Matching open pages reload. Bookmarks, history, passwords, permissions, and app/WPP login data are kept.",
  "desktop.browser.fillUsername": "Fill only the username on this page?",
  "desktop.browser.fillPassword": "Fill only the password on this page?",
  "desktop.browser.clearSelected": "Clear the selected browser data? Downloaded files are kept.",
  "desktop.browser.range.hour": "Last hour",
  "desktop.browser.range.day": "Last 24 hours",
  "desktop.browser.range.week": "Last 7 days",
  "desktop.browser.range.month": "Last 30 days",
  "desktop.browser.range.all": "All time",
  "desktop.browser.downloadDirectory": "Choose download folder",
  "desktop.browser.clear.downloads": "Clear download history? Downloaded files will stay on disk.",
  "desktop.browser.media": "Allow device access for {{origin}}?",
  "desktop.browser.media.both": "This page wants to use your camera and microphone.",
  "desktop.browser.media.camera": "This page wants to use your camera.",
  "desktop.browser.media.microphone": "This page wants to use your microphone.",
  "desktop.browser.importPasswords": "Import passwords from a Chrome, Edge, or Firefox CSV export",
  "desktop.browser.importCookies": "Import cookies from a JSON export",
  "desktop.browser.clear.history": "Clear browser history?",
  "desktop.browser.clear.cache": "Clear cached browser files?",
  "desktop.browser.clear.cookies": "Clear browser cookies and site data? This signs you out of browser websites.",
  "desktop.browser.clear.passwords": "Delete all saved browser passwords?",
  "desktop.browser.clearConfirm": "Clear",
  "desktop.browser.saveLogin": "Save this login?",
  "desktop.browser.fillLogin": "Fill this login?",
  "desktop.browser.unlockReason": "Unlock saved passwords in CookieMonster",
  "desktop.browser.fillLoginDetail":
    "Fill the saved password for {{username}} on {{origin}}? This gives the website access to the password.",
  "desktop.browser.fill": "Fill login",
  "desktop.browser.saveLoginDetail": "Save the password for {{username}} on {{origin}} using OS-protected storage?",
  "desktop.browser.save": "Save",
  "desktop.browser.saveDownload": "Save download",
  "desktop.browser.leave": "Leave this page?",
  "desktop.browser.leaveDetail": "Changes you made may not be saved.",
  "desktop.browser.leaveConfirm": "Leave",
  "desktop.browser.stay": "Stay",
  "desktop.browser.screenshotConsent": "Share this tab's visible pixels with the agent?",
  "desktop.browser.screenshotDetail":
    "Task: {{task}}\nTab: {{tab}}\nSource: {{url}}\n\nThis one screenshot shares all visible pixels, including passwords, editable values, canvas and cross-origin frames. Nothing is redacted or checked for sensitive data. An attachment already shared cannot be recalled. This does not grant future screenshots.",
  "desktop.browser.screenshotUnavailable": "Browser screenshot unavailable or exceeds the size limit.",
  "desktop.browser.screenshotDenied": "Browser screenshot consent was not granted.",
  "desktop.browser.screenshotDeliveryUnavailable": "Browser screenshot delivery unavailable.",
  "desktop.browser.access": "Allow agent access to this tab?",
  "desktop.browser.websiteAccessRequired":
    "Open the website in this tab and allow agent access before using page tools.",
  "desktop.browser.accessSiteDetail":
    "Allow the agent to read and interact with {{origin}} in this tab? Visiting a different website turns access off. Tool approvals and file transfer controls still apply.",
  "desktop.browser.accessDetail":
    "The agent may read and interact with signed-in pages in this tab on allowed hosts. Other tabs remain private. Browser cookies are stored in a separate persistent profile.",
  "desktop.browser.allow": "Allow",
  "desktop.browser.cancel": "Cancel",
  "desktop.install.title": "Install CookieMonster",
  "desktop.install.confirm": "Install for My User",
  "desktop.install.detail":
    "Install CookieMonster at {{destination}} and open it there? No administrator access is needed. Existing apps will not be replaced.",
  "desktop.install.manual":
    "Automatic installation cannot safely identify the original disk-image app. Quit, open the mounted CookieMonster disk image in Finder, and copy CookieMonster.app into your home Applications folder (Go > Go to Folder: ~/Applications). Create that folder if needed. Do not replace an existing app. Then open the copied app and eject the disk image.",
  "desktop.install.failed":
    "CookieMonster could not be installed or opened at {{destination}}. Existing apps were not replaced. If a partial copy was created, inspect it in Finder before removing it and retrying. If the copy is complete, open it in Finder. Follow any macOS security prompts or contact your administrator.",

  "desktop.menu.app": "OpenCode",
  "desktop.menu.file": "File",
  "desktop.menu.edit": "Edit",
  "desktop.menu.view": "View",
  "desktop.menu.go": "Go",
  "desktop.menu.window": "Window",
  "desktop.menu.help": "Help",
  "desktop.menu.checkForUpdates": "Check for Updates...",
  "desktop.menu.settings": "Settings",
  "desktop.menu.reloadWebview": "Reload Webview",
  "desktop.menu.restart": "Restart",
  "desktop.menu.exportLogs": "Export Logs...",
  "desktop.menu.newSession": "New Session",
  "desktop.menu.openProject": "Open Project...",
  "desktop.menu.newWindow": "New Window",
  "desktop.menu.closeWindow": "Close Window",
  "desktop.menu.undo": "Undo",
  "desktop.menu.redo": "Redo",
  "desktop.menu.cut": "Cut",
  "desktop.menu.copy": "Copy",
  "desktop.menu.paste": "Paste",
  "desktop.menu.delete": "Delete",
  "desktop.menu.selectAll": "Select All",
  "desktop.menu.toggleSidebar": "Toggle Sidebar",
  "desktop.menu.toggleTerminal": "Toggle Terminal",
  "desktop.menu.toggleFileTree": "Toggle File Tree",
  "desktop.menu.reload": "Reload",
  "desktop.menu.toggleDeveloperTools": "Toggle Developer Tools",
  "desktop.menu.actualSize": "Actual Size",
  "desktop.menu.zoomIn": "Zoom In",
  "desktop.menu.zoomOut": "Zoom Out",
  "desktop.menu.toggleFullScreen": "Toggle Full Screen",
  "desktop.menu.back": "Back",
  "desktop.menu.forward": "Forward",
  "desktop.menu.previousSession": "Previous Session",
  "desktop.menu.nextSession": "Next Session",
  "desktop.menu.previousProject": "Previous Project",
  "desktop.menu.nextProject": "Next Project",
  "desktop.menu.minimize": "Minimize",
  "desktop.menu.maximize": "Maximize",
  "desktop.menu.documentation": "OpenCode Documentation",
  "desktop.menu.supportForum": "Support Forum",
  "desktop.menu.shareFeedback": "Share Feedback",
  "desktop.menu.reportBug": "Report a Bug",
  "desktop.menu.ariaLabel": "OpenCode menu",

  "desktop.updater.dialog.checkFailed.message": "Update check failed.",
  "desktop.updater.dialog.checkFailed.title": "Update Error",
  "desktop.updater.dialog.upToDate.message": "You're up to date.",
  "desktop.updater.dialog.upToDate.title": "No Updates",
  "desktop.updater.dialog.ready.message": "Update {{version}} downloaded. Restart now?",
  "desktop.updater.dialog.ready.title": "Update Ready",
  "desktop.updater.dialog.restart": "Restart",
  "desktop.updater.dialog.later": "Later",

  "desktop.recovery.action.relaunch": "Relaunch",
  "desktop.recovery.action.exportLogs": "Export Logs",
  "desktop.recovery.action.keepWaiting": "Keep Waiting",
  "desktop.recovery.action.quit": "Quit",
  "desktop.recovery.loadFailed": "OpenCode failed to load",
  "desktop.recovery.terminated": "OpenCode window terminated unexpectedly",
  "desktop.recovery.unresponsive": "OpenCode is not responding",
  "desktop.recovery.unresponsive.detail": "You can relaunch the app, open the logs, or keep waiting.",
  "desktop.recovery.loadFailed.detail": "Window: {{window}}\nURL: {{url}}\nError: {{code}} {{description}}",
  "desktop.recovery.terminated.detail": "Window: {{window}}\nReason: {{reason}}\nCode: {{code}}",
  "desktop.recovery.unknown": "<unknown>",

  "desktop.dialog.chooseFolder": "Choose a folder",
  "desktop.dialog.chooseFile": "Choose a file",
  "desktop.dialog.saveFile": "Save file",
  "desktop.dialog.files": "Files",
  "desktop.server.local": "Local Server",

  "desktop.wsl.error.windowsOnly": "WSL is only available on Windows",
  "desktop.wsl.error.unavailable": "WSL is unavailable",
  "desktop.wsl.error.listInstalled": "Failed to list installed WSL distros",
  "desktop.wsl.error.listOnline": "Failed to list online WSL distros",
  "desktop.wsl.error.executeDistro": "Cannot execute commands in distro",
  "desktop.wsl.error.installWsl": "WSL installation failed",
  "desktop.wsl.error.installDistro": "Failed to install distro: {{distro}}",
  "desktop.wsl.error.installOpencode": "OpenCode installation failed",
  "desktop.wsl.error.alreadyAdded": "{{distro}} is already added",
  "desktop.wsl.error.opencodeMissing": "opencode is not installed in this distro",
  "desktop.wsl.error.opencodeCannotRun": "opencode is installed but could not run",
  "desktop.wsl.error.opencodeNotInstalled": "OpenCode is not installed in {{distro}}",
  "desktop.wsl.error.updateVersion":
    "OpenCode update finished but {{distro}} still reports {{installed}}; expected {{expected}}",
  "desktop.wsl.error.noVersion": "no version",
  "desktop.wsl.error.serverExited": "WSL server exited after startup (code={{code}} signal={{signal}})",
  "desktop.wsl.error.serverExitedBeforeHealthy":
    "WSL server exited before becoming healthy (code={{code}} signal={{signal}}){{output}}",
  "desktop.wsl.error.healthTimeout": "Sidecar for {{distro}} health check timed out after {{timeout}}ms",
  "desktop.wsl.error.commandTimeout": "{{command}} {{args}} timed out after {{timeout}}ms",
  "desktop.wsl.error.failedPort": "Failed to get port",

  "desktop.picker.error.notSelected": "File was not selected by the picker",
  "desktop.picker.error.sizeLimit": "Selected attachments exceed the {{limit}} MB limit",
  // English fallback until reviewed translations are available. Append to preserve indexed locale keys.
  "desktop.browser.recovery.failed":
    "This page could not be restored. Use Reload, enter an address, or close this tab.",
  "desktop.browser.device.invalid": "Device dimensions must be whole numbers from 160 to 4096 CSS pixels.",
  "desktop.browser.import.review": "Review import",
  "desktop.browser.import.confirm": "Import",
  "desktop.browser.import.close": "Close",
  "desktop.browser.import.counts":
    "Valid rows: {{valid}}\nDuplicate source rows: {{duplicate}}\nAdd: {{add}}\nReplace: {{replace}}\nUnchanged: {{unchanged}}\nUnsupported rows skipped: {{unsupported}}",
  "desktop.browser.import.scope":
    "Only the selected category in the shared CookieMonster browser profile is affected, not app or WPP login data. No page or vault permissions are granted. Export files are plaintext and may contain passwords or session credentials; remove them yourself when no longer needed.",
  "desktop.browser.import.passwords":
    "Passwords match by normalized origin and username. The last source row wins; changed passwords replace existing values while retaining account IDs. Exact duplicates are skipped.",
  "desktop.browser.import.cookies":
    "Cookies match by domain scope, path and name. The last source row wins; conflicts replace existing cookies, including session credentials. Writes are sequential, not atomic. A failure or interruption may leave earlier writes applied. There is no rollback or automatic retry.",
  "desktop.browser.import.bookmarks":
    "Bookmark folders are flattened. Unsupported URLs are skipped. Normalized existing URLs keep their titles, IDs and pin state; for new URLs, the first source row wins.",
  "desktop.browser.import.result": "Import results",
  "desktop.browser.import.saved":
    "Saved: {{successful}}\nUnchanged: {{unchanged}}\nDuplicate source rows: {{duplicate}}\nUnsupported rows skipped: {{unsupported}}",
  "desktop.browser.import.cookieResult":
    "Successful writes: {{successful}}\nFailed writes: {{failed}}\nUnattempted writes: {{unattempted}}\nUnchanged: {{unchanged}}\nDuplicate source rows: {{duplicate}}\n{{flush}}\n{{status}}\nNo rollback or automatic retry was attempted.",
  "desktop.browser.import.flushed": "Successful writes were flushed to the cookie store.",
  "desktop.browser.import.flushFailed":
    "Cookie store flush failed. Successful writes may be active, but durable saving is not confirmed.",
  "desktop.browser.import.noFlush": "No successful cookie writes required flushing.",
  "desktop.browser.import.finished": "Import processing finished.",
  "desktop.browser.import.interrupted":
    "Import interrupted or the destination changed. Review a fresh import before continuing.",
  "desktop.browser.import.unavailable":
    "Import unavailable. Check the selected category, window and vault access, then choose the export again.",
  "desktop.browser.import.file":
    "Cannot read this export. Choose an available regular CSV, JSON or HTML file no larger than 5 MB.",
  "desktop.browser.import.invalid":
    "This export is malformed, unsupported or exceeds the category limit. No import writes were made. Cookie imports accept only the documented fields; partitioned or container-scoped cookies are not supported.",
  "desktop.browser.import.stale":
    "The window, task, vault access or destination changed. No further import writes were made. Choose the file again for a fresh review.",
  "desktop.browser.backup.passphraseTitle": "Encrypted password backup",
  "desktop.browser.backup.passphrasePrompt":
    "Enter a backup passphrase of at least 12 characters in the Password field. Leave User name empty. This passphrase cannot be recovered or reset.",
  "desktop.browser.backup.passphraseConfirm":
    "Enter the same backup passphrase again in the Password field. Leave User name empty.",
  "desktop.browser.backup.passphraseMismatch": "The backup passphrases did not match. No file was written.",
  "desktop.browser.backup.exportTitle": "Export encrypted password backup",
  "desktop.browser.backup.importTitle": "Import encrypted password backup",
  "desktop.browser.backup.exported": "Encrypted password backup saved",
  "desktop.browser.backup.exportedDetail":
    "Saved {{file}}. Keep the file and its passphrase separate. CookieMonster cannot recover the passphrase.",
  "desktop.browser.backup.review": "Review encrypted password backup import",
  "desktop.browser.backup.counts":
    "Valid accounts: {{valid}}\nDuplicate source accounts: {{duplicate}}\nAdd: {{add}}\nReplace: {{replace}}\nUnchanged: {{unchanged}}",
  "desktop.browser.backup.imported":
    "Added: {{add}}\nReplaced: {{replace}}\nUnchanged: {{unchanged}}\nDuplicate source accounts: {{duplicate}}",
  "desktop.browser.backup.unavailable":
    "Encrypted password backup is unavailable. Unlock the vault in a visible window and try again.",
  "desktop.browser.backup.authentication":
    "Fresh device authentication was cancelled or unavailable. No backup data was read or written.",
  "desktop.browser.backup.exportFailed":
    "The encrypted backup could not be completed. Existing backup files are never replaced; choose a new filename and try again.",
  "desktop.browser.backup.importFailed":
    "This backup is unreadable, unsupported, too large, corrupted, or the passphrase is wrong. No password changes were made.",
  "desktop.browser.backup.stale":
    "The window, task, vault access or password destination changed. No backup import was committed.",
  "desktop.browser.notifications.title": "Allow notifications for {{origin}}?",
  "desktop.browser.notifications.detail":
    "Task: {{task}}\nTab: {{tab}}\n\nAllow is saved for this exact website. Notifications are permitted only while its private main page is selected and visible in CookieMonster. OS notification settings still apply. Blocking later prevents new notifications but cannot recall delivered notifications.",
  "desktop.browser.sitePermission.invalid": "Invalid site permission",
  "desktop.browser.sitePermission.limit": "Site limit reached",
  "desktop.browser.diagnosticsConsent": "Share bounded console diagnostics with the agent?",
  "desktop.browser.diagnosticsDetail":
    "Task {{task}} requests {{duration}}ms of console severity counts from tab {{tab}} at {{url}}. Message text, source URLs, stack traces, request data, and network activity are not collected.",
  "desktop.browser.diagnosticsDenied": "Browser diagnostics consent was not granted.",
  "desktop.browser.diagnosticsDeliveryUnavailable": "Browser diagnostics delivery unavailable.",
  "desktop.browser.siteToolConsent": "Allow this website tool to run?",
  "desktop.browser.siteToolDetail":
    "Task {{task}} requests website tool {{tool}} in tab {{tab}} at {{url}}.\n\nExact JSON arguments:\n{{arguments}}\n\nThe website supplies this tool and receives these arguments. It may change website or account data. CookieMonster will return its bounded result to the agent as untrusted content.",
  "desktop.browser.siteToolDenied": "Website tool consent was not granted.",
  "desktop.browser.siteToolDeliveryUnavailable": "Website tool delivery unavailable.",
  "desktop.browser.networkConsent": "Share bounded network counts with the agent?",
  "desktop.browser.networkDetail":
    "Task {{task}} requests {{duration}}ms of HTTP(S) Fetch/XHR completion and transport/abort failure counts from tab {{tab}} at {{url}}. Only terminal events received during this window and attributed by Electron to the main frame are counted. This may include ancestor-attributed dedicated workers and requests initiated before approval. Coverage is incomplete; zero counts do not mean the page is healthy. Request URLs, referrers, headers, bodies, cookies, credentials and raw errors are not retained or shared. No CDP access or vault permission is granted.",
  "desktop.browser.networkNativeOnly": "Network observation requires native routing.",
  "desktop.browser.operationUnavailable": "Browser operation interrupted or unavailable.",
  "desktop.browser.downloadRecovery.title": "Resume this saved download?",
  "desktop.browser.downloadRecovery.detail":
    "File: {{filename}}\nStarted from: {{origin}}\nDownload server: {{source}}\nDestination folder: {{directory}}\n\nThis uses your current browser login. The saved partial file and server response will be checked first. A new numbered file will be saved in the original folder; existing files will not be replaced. If recovery fails, try again from the page.",
  "desktop.browser.downloadRecovery.unavailable":
    "This download cannot be resumed. Its partial file, destination, permission, or server response is unavailable or changed. Try again from the page.",
  "desktop.browser.generation.length":
    "The selected length is {{length}}, but this form supports {{min}}-{{max}} characters. Choose a length in that range and try again. No password was generated or filled; your settings were not changed.",
  "desktop.browser.backup.passphrasePromptMac":
    "Enter a backup passphrase of at least 12 characters. This passphrase cannot be recovered or reset.",
  "desktop.browser.backup.passphraseConfirmMac": "Enter the same backup passphrase again.",
  "desktop.browser.displayCapture.title": "Allow screen sharing for {{origin}}?",
  "desktop.browser.displayCapture.detail":
    "Task: {{task}}\nTab: {{tab}}\n\nAllow is saved for this exact website. Apple still asks you to choose a screen or window for each capture. Revoking Allow replaces matching pages to stop active capture before restoring their history.",
  "desktop.browser.clipboard.title": "Allow clipboard access for {{origin}}?",
  "desktop.browser.clipboard.detail":
    "Task: {{task}}\nTab: {{tab}}\n\nAllow is saved for this exact website. Clipboard access is permitted only while its private main page is selected and visible in CookieMonster, with no agent control or pending operation.",
  // English fallback until reviewed translations are available. Append to preserve indexed locale keys.
  "desktop.browser.tabGrantDetail":
    "Allow Agent Access for this entire tab, currently at {{origin}}? This includes embedded websites, page actions, screenshots of all visible pixels without redaction, diagnostics and site actions, with no further approvals. Access stays on across website changes until revoked or the tab closes. Other tabs, saved passwords and OS capabilities are not granted. File transfer controls still apply. Content already shared cannot be recalled.",
  "desktop.browser.actionDispatchFailed":
    "Browser input may have been dispatched, but its completion could not be confirmed.",
  "desktop.browser.actionObservationFailed":
    "Browser input may have taken effect, but the refreshed page state could not be confirmed.",
  "desktop.browser.actionOutcomeUnknown":
    "Browser input may have been dispatched. Observe the current tab state before sending further input.",
  "desktop.browser.pageLoadCause": "Page loading failed: {{cause}} ({{code}}).",
  "desktop.browser.pageCrashCause": "The browser page stopped: {{cause}}. Close and reopen this tab to recover.",
  "desktop.browser.untrackedLeave":
    "This page requested to leave with unsaved changes. The page was kept open. Use the address bar or browser navigation controls to request a confirmed destination; the browser cannot safely replay a page's form submission.",
  "desktop.browser.visualLimit":
    "This viewport cannot fit the image limit while retaining the minimum supported half-resolution.",
  "desktop.browser.visualStale":
    "The observed browser image is no longer current. Take a fresh screenshot before visual input.",
  "desktop.browser.visualUnsupported":
    "The browser cannot verify this visual target's document and layout. Use a semantic control or a fresh supported view.",
  "desktop.install.replaceDetail":
    "Install CookieMonster at {{destination}} and open it there? Quit any installed copy first. An existing app at this location will be replaced after the new copy is complete. Only the immediately previous app is kept in a CookieMonster Backup- folder beside it. Older installer-owned backups are removed after successful replacement. Failed-install recovery copies are left alone, and cleanup failures can leave extra backups. No administrator access is needed. Settings and sign-in data are not changed.",
  "desktop.install.replaceManual":
    "Automatic installation cannot safely identify the original disk-image app. Quit CookieMonster, open the mounted disk image in Finder, and copy CookieMonster.app into your home Applications folder (Go > Go to Folder: ~/Applications). Create that folder if needed. If an app is already there, move it aside before copying or choose Replace in Finder. Then open the copied app and eject the disk image.",
  "desktop.install.replaceFailed":
    "CookieMonster could not be installed or opened at {{destination}}. If copying failed, the existing app was not moved. If replacement started, look for the previous app in a CookieMonster Backup- folder beside this location. A partial new copy may remain in a CookieMonster Install- folder. Failed installation does not prune backups. If installation succeeded but opening failed, older installer-owned backups may already have been removed; the immediately previous app is retained. Inspect these folders in Finder before removing anything or retrying. If the installed copy is complete, open it in Finder. Follow any macOS security prompts or contact your administrator.",
} as const

export type DesktopNativeKey = keyof typeof DESKTOP_NATIVE_ENGLISH
export type DesktopNativeMessages = Record<DesktopNativeKey, string>
export type DesktopNativeBundle = { locale: DesktopNativeLocale; messages: DesktopNativeMessages }

export const DESKTOP_NATIVE_KEYS = Object.keys(DESKTOP_NATIVE_ENGLISH) as DesktopNativeKey[]
export const DESKTOP_NATIVE_MAX_PAYLOAD_BYTES = 64 * 1024

export function createDesktopNativeBundle(
  locale: DesktopNativeLocale,
  translate: (key: DesktopNativeKey) => string,
): DesktopNativeBundle {
  return {
    locale,
    messages: Object.fromEntries(DESKTOP_NATIVE_KEYS.map((key) => [key, translate(key)])) as DesktopNativeMessages,
  }
}

export function parseDesktopNativeBundle(value: unknown): DesktopNativeBundle | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > DESKTOP_NATIVE_MAX_PAYLOAD_BYTES) return undefined
  } catch {
    return undefined
  }
  const bundle = value as { locale?: unknown; messages?: unknown }
  if (!DESKTOP_NATIVE_LOCALES.some((locale) => locale === bundle.locale)) return undefined
  if (!bundle.messages || typeof bundle.messages !== "object" || Array.isArray(bundle.messages)) return undefined
  const messages = bundle.messages as Record<string, unknown>
  const keys = Object.keys(messages)
  if (keys.length !== DESKTOP_NATIVE_KEYS.length) return undefined
  if (!DESKTOP_NATIVE_KEYS.every((key) => typeof messages[key] === "string")) return undefined
  if (!keys.every((key) => key in DESKTOP_NATIVE_ENGLISH)) return undefined
  return bundle as DesktopNativeBundle
}

export function formatDesktopNativeMessage(message: string, params?: Record<string, string | number>) {
  if (!params) return message
  return message.replace(/\{\{([^{}]+)\}\}/g, (match, key: string) => {
    const value = params[key]
    return value === undefined ? match : String(value)
  })
}
