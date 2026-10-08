import { describe, expect, test } from "bun:test"
import {
  createDesktopNativeBundle,
  DESKTOP_NATIVE_ENGLISH,
  DESKTOP_NATIVE_KEYS,
  DESKTOP_NATIVE_LABELS,
  DESKTOP_NATIVE_LOCALES,
  DESKTOP_NATIVE_LOCALE_TAGS,
  detectDesktopNativeLocale,
  DESKTOP_NATIVE_MAX_PAYLOAD_BYTES,
  formatDesktopNativeMessage,
  parseDesktopNativeBundle,
} from "./desktop-native"

describe("desktop native translations", () => {
  test("installer copy explains replacement, backup retention and failure recovery", () => {
    const destination = "/Users/me/Applications/CookieMonster.app"
    const detail = formatDesktopNativeMessage(DESKTOP_NATIVE_ENGLISH["desktop.install.replaceDetail"], { destination })
    expect(detail).toContain(destination)
    expect(detail).toContain("will be replaced after the new copy is complete")
    expect(detail).toContain("CookieMonster Backup-")
    expect(detail).toContain("Only the immediately previous app")
    expect(detail).toContain("removed after successful replacement")
    expect(detail).toContain("Failed-install recovery copies are left alone")
    expect(detail).toContain("cleanup failures can leave extra backups")
    expect(detail).toContain("Settings and sign-in data are not changed")
    expect(DESKTOP_NATIVE_ENGLISH["desktop.install.replaceManual"]).toContain("choose Replace in Finder")
    const failed = formatDesktopNativeMessage(DESKTOP_NATIVE_ENGLISH["desktop.install.replaceFailed"], { destination })
    expect(failed).toContain(destination)
    expect(failed).toContain("existing app was not moved")
    expect(failed).toContain("CookieMonster Install-")
    expect(failed).toContain("CookieMonster Backup-")
    expect(failed).toContain("Failed installation does not prune backups")
    expect(failed).toContain("installation succeeded but opening failed")
  })
  test("describes the complete tab grant in its English fallback", () => {
    const detail = formatDesktopNativeMessage(DESKTOP_NATIVE_ENGLISH["desktop.browser.tabGrantDetail"], {
      origin: "https://example.test",
    })
    for (const value of [
      "https://example.test",
      "entire tab",
      "without redaction",
      "no further approvals",
      "stays on across website changes",
      "Other tabs",
      "OS capabilities",
      "cannot be recalled",
    ])
      expect(detail).toContain(value)
    expect(detail).not.toContain("{{")
    expect(DESKTOP_NATIVE_KEYS).toContain("desktop.browser.tabGrantDetail")
  })

  test("network consent appends distinct keys without changing console disclosure", () => {
    expect(DESKTOP_NATIVE_KEYS.slice(265, 269)).toEqual([
      "desktop.browser.networkConsent",
      "desktop.browser.networkDetail",
      "desktop.browser.networkNativeOnly",
      "desktop.browser.operationUnavailable",
    ])
    expect(DESKTOP_NATIVE_ENGLISH["desktop.browser.diagnosticsConsent"]).toBe(
      "Share bounded console diagnostics with the agent?",
    )
    expect(DESKTOP_NATIVE_ENGLISH["desktop.browser.diagnosticsDetail"]).toBe(
      "Task {{task}} requests {{duration}}ms of console severity counts from tab {{tab}} at {{url}}. Message text, source URLs, stack traces, request data, and network activity are not collected.",
    )
    const detail = formatDesktopNativeMessage(DESKTOP_NATIVE_ENGLISH["desktop.browser.networkDetail"], {
      task: "task-one",
      tab: "tab-one",
      url: "https://example.test",
      duration: 250,
    })
    for (const text of [
      "task-one",
      "tab-one",
      "250ms",
      "terminal events",
      "dedicated workers",
      "before approval",
      "incomplete",
      "not retained",
      "No CDP",
    ])
      expect(detail).toContain(text)
  })
  test("download recovery appends consent keys and interpolates source and destination", () => {
    expect(DESKTOP_NATIVE_KEYS.slice(269, 272)).toEqual([
      "desktop.browser.downloadRecovery.title",
      "desktop.browser.downloadRecovery.detail",
      "desktop.browser.downloadRecovery.unavailable",
    ])
    const detail = formatDesktopNativeMessage(DESKTOP_NATIVE_ENGLISH["desktop.browser.downloadRecovery.detail"], {
      filename: "report.pdf",
      origin: "https://page.test",
      source: "https://cdn.test",
      directory: "/downloads",
    })
    for (const value of [
      "report.pdf",
      "https://page.test",
      "https://cdn.test",
      "/downloads",
      "current browser login",
      "will not be replaced",
      "try again from the page",
    ])
      expect(detail).toContain(value)
    expect(detail).not.toContain("{{")
  })
  test("preserves the fixed key prefix used by indexed locale dictionaries", () => {
    // Baseline ff96a0e61: append keys, never shift the existing 217 locale indices.
    expect(new Bun.CryptoHasher("sha256").update(JSON.stringify(DESKTOP_NATIVE_KEYS.slice(0, 217))).digest("hex")).toBe(
      "2fb3560cf95ef2f103d3cf1ad5719e055c90e1394048ac8f8627d30b7456654b",
    )
  })

  test("uses native language names independent of the active locale", () => {
    expect(DESKTOP_NATIVE_LOCALES.map((locale) => DESKTOP_NATIVE_LABELS[locale])).toEqual([
      "English",
      "简体中文",
      "繁體中文",
      "한국어",
      "Deutsch",
      "Español",
      "Français",
      "Dansk",
      "日本語",
      "Polski",
      "Русский",
      "Українська",
      "Bosanski",
      "العربية",
      "Norsk",
      "Português (Brasil)",
      "ไทย",
      "Türkçe",
      "हिन्दी",
      "Nederlands",
      "Bahasa Indonesia",
      "Tiếng Việt",
      "Italiano",
      "اردو",
      "پنجابی",
      "Azərbaycanca",
      "Suomi",
      "Svenska",
      "አማርኛ",
      "Български",
      "বাংলা",
      "Català",
      "Čeština",
      "ދިވެހި",
      "རྫོང་ཁ",
      "Ελληνικά",
      "Eesti",
      "فارسی",
      "Føroyskt",
      "Hrvatski",
      "Magyar",
      "Հայերեն",
      "Íslenska",
      "ქართული",
      "ខ្មែរ",
      "ລາວ",
      "Lietuvių",
      "Latviešu",
      "Македонски",
      "Монгол",
      "Bahasa Melayu",
      "မြန်မာ",
      "नेपाली",
      "Română",
      "සිංහල",
      "Slovenčina",
      "Slovenščina",
      "Shqip",
      "Српски",
      "Тоҷикӣ",
      "Türkmençe",
      "Oʻzbekcha",
    ])
  })

  test("accepts the exact typed bundle", () => {
    const bundle = createDesktopNativeBundle("en", (key) => DESKTOP_NATIVE_ENGLISH[key])
    expect(parseDesktopNativeBundle(bundle)).toEqual(bundle)
  })

  test("rejects unsupported locales and mismatched key sets", () => {
    const bundle = createDesktopNativeBundle("en", (key) => DESKTOP_NATIVE_ENGLISH[key])
    expect(parseDesktopNativeBundle({ ...bundle, locale: "en-US" })).toBeUndefined()
    expect(
      parseDesktopNativeBundle({
        ...bundle,
        messages: Object.fromEntries(DESKTOP_NATIVE_KEYS.slice(1).map((key) => [key, bundle.messages[key]])),
      }),
    ).toBeUndefined()
    expect(parseDesktopNativeBundle({ ...bundle, messages: { ...bundle.messages, extra: "no" } })).toBeUndefined()
    expect(
      parseDesktopNativeBundle({
        ...bundle,
        messages: { ...bundle.messages, [DESKTOP_NATIVE_KEYS[0]]: "x".repeat(DESKTOP_NATIVE_MAX_PAYLOAD_BYTES) },
      }),
    ).toBeUndefined()
    expect(
      parseDesktopNativeBundle({ ...bundle, messages: { ...bundle.messages, [DESKTOP_NATIVE_KEYS[0]]: 1 } }),
    ).toBeUndefined()
  })

  test("preserves exact stale-ref English and interpolates the ref literally", () => {
    const message = DESKTOP_NATIVE_ENGLISH["desktop.browser.driver.staleRef"]
    expect(message).toBe("Element ref {{ref}} is stale. Read browser state again.")
    for (const ref of ["one.snapshot:send", "$&{{unknown}}"])
      expect(formatDesktopNativeMessage(message, { ref })).toBe(
        `Element ref ${ref} is stale. Read browser state again.`,
      )
  })

  test("interpolates native templates without changing unknown placeholders", () => {
    expect(formatDesktopNativeMessage("{{known}} {{unknown}}", { known: "yes" })).toBe("yes {{unknown}}")
  })

  test("generation recovery appends bounded length guidance without shifting existing keys", () => {
    expect(DESKTOP_NATIVE_KEYS[272]).toBe("desktop.browser.generation.length")
    expect(
      formatDesktopNativeMessage(DESKTOP_NATIVE_ENGLISH["desktop.browser.generation.length"], {
        length: 20,
        min: 24,
        max: 24,
      }),
    ).toBe(
      "The selected length is 20, but this form supports 24-24 characters. Choose a length in that range and try again. No password was generated or filled; your settings were not changed.",
    )
  })
  test("macOS backup prompts append without shifting existing locale indices", () => {
    expect(new Bun.CryptoHasher("sha256").update(JSON.stringify(DESKTOP_NATIVE_KEYS.slice(0, 273))).digest("hex")).toBe(
      "cb199920498683911bd2b3b91bc2c4b2ceca533acabae32a72e3f99aeb0bd82d",
    )
    expect(DESKTOP_NATIVE_KEYS.slice(273, 275)).toEqual([
      "desktop.browser.backup.passphrasePromptMac",
      "desktop.browser.backup.passphraseConfirmMac",
    ])
    expect(DESKTOP_NATIVE_ENGLISH["desktop.browser.backup.passphrasePromptMac"]).not.toContain("User name")
  })
  test("screen sharing and clipboard consent append after the validated native prefix", () => {
    expect(DESKTOP_NATIVE_KEYS.slice(275, 279)).toEqual([
      "desktop.browser.displayCapture.title",
      "desktop.browser.displayCapture.detail",
      "desktop.browser.clipboard.title",
      "desktop.browser.clipboard.detail",
    ])
  })
})

describe("desktop native locale detection", () => {
  test("follows preference order and skips invalid or unsupported tags", () => {
    expect(detectDesktopNativeLocale(["not_a_locale", "fr-FR"])).toBe("fr")
    expect(detectDesktopNativeLocale(["eo", "de-DE"])).toBe("de")
  })

  test("uses Unicode likely subtags for script-sensitive bundles", () => {
    expect(detectDesktopNativeLocale(["zh-TW"])).toBe("zht")
    expect(detectDesktopNativeLocale(["zh-SG"])).toBe("zh")
    expect(detectDesktopNativeLocale(["pa-PK"])).toBe("pa")
    expect(detectDesktopNativeLocale(["pa-IN", "fr"])).toBe("fr")
    expect(detectDesktopNativeLocale(["az-Cyrl", "de"])).toBe("de")
    expect(detectDesktopNativeLocale(["sr-Cyrl"])).toBe("sr")
    expect(detectDesktopNativeLocale(["sr-Latn", "en"])).toBe("en")
    expect(detectDesktopNativeLocale(["uz-Latn"])).toBe("uz")
  })

  test("recognizes Norwegian language tags", () => {
    expect(detectDesktopNativeLocale(["no"])).toBe("no")
    expect(detectDesktopNativeLocale(["nb-NO"])).toBe("no")
    expect(detectDesktopNativeLocale(["nn-NO"])).toBe("no")
  })
})

describe("desktop native ICU data", () => {
  test("accepts every locale in standard Intl formatters", () => {
    for (const locale of DESKTOP_NATIVE_LOCALES) {
      const tag = DESKTOP_NATIVE_LOCALE_TAGS[locale]
      expect(() => new Intl.Locale(tag), `${locale} locale`).not.toThrow()
      expect(() => new Intl.NumberFormat(tag), `${locale} number`).not.toThrow()
      expect(() => new Intl.DateTimeFormat(tag), `${locale} date`).not.toThrow()
      expect(() => new Intl.PluralRules(tag), `${locale} plural`).not.toThrow()
      expect(() => new Intl.ListFormat(tag), `${locale} list`).not.toThrow()
      expect(() => new Intl.DisplayNames(tag, { type: "language" }), `${locale} names`).not.toThrow()
      expect(() => new Intl.Segmenter(tag), `${locale} segmenter`).not.toThrow()
    }
  })
})
