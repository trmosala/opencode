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
  test("network consent appends distinct keys without changing console disclosure", () => {
    expect(DESKTOP_NATIVE_KEYS.slice(-4)).toEqual([
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
