import { randomUUID } from "node:crypto"
import type { BrowserDevicePreset, BrowserZoomRule } from "@opencode-ai/app/browser-panel"
import { browserDeviceSize } from "@opencode-ai/app/browser-panel"

export const MAX_ZOOM_RULES = 200
export const MAX_DEVICE_PRESETS = 20

export function presentationOrigin(value: unknown) {
  if (typeof value !== "string" || value.length > 2048 || !URL.canParse(value)) return
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return
  return url.origin
}

export function zoomRuleRows(value: unknown): BrowserZoomRule[] {
  if (!Array.isArray(value) || value.length > MAX_ZOOM_RULES) throw new Error("Invalid browser zoom preferences")
  const rows = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid browser zoom preferences")
    const row = entry as Record<string, unknown>
    const origin = presentationOrigin(row.origin)
    if (
      !origin ||
      origin !== row.origin ||
      typeof row.factor !== "number" ||
      !Number.isFinite(row.factor) ||
      row.factor < 0.5 ||
      row.factor > 3
    )
      throw new Error("Invalid browser zoom preferences")
    return { origin, factor: Math.round(row.factor * 100) / 100 }
  })
  if (new Set(rows.map((row) => row.origin)).size !== rows.length) throw new Error("Invalid browser zoom preferences")
  return rows
}

export function devicePresetRows(value: unknown): BrowserDevicePreset[] {
  if (!Array.isArray(value) || value.length > MAX_DEVICE_PRESETS) throw new Error("Invalid browser device presets")
  const rows = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid browser device presets")
    const row = entry as Record<string, unknown>
    const name = typeof row.name === "string" ? row.name.trim() : ""
    const size = browserDeviceSize(row.size)
    if (
      typeof row.id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(row.id) ||
      !name ||
      name.length > 80 ||
      /[\x00-\x1f\x7f]/.test(name) ||
      !size
    )
      throw new Error("Invalid browser device presets")
    return { id: row.id, name, size }
  })
  if (
    new Set(rows.map((row) => row.id)).size !== rows.length ||
    new Set(rows.map((row) => row.name.toLocaleLowerCase())).size !== rows.length
  )
    throw new Error("Invalid browser device presets")
  return rows
}

export function setZoomRule(rows: BrowserZoomRule[], url: string, factor: number) {
  const origin = presentationOrigin(url)
  if (!origin || !Number.isFinite(factor) || factor < 0.5 || factor > 3)
    throw new Error("Invalid browser zoom preferences")
  const current = zoomRuleRows(rows)
  const next = current.filter((row) => row.origin !== origin)
  if (Math.abs(factor - 1) < 0.001) return next
  if (next.length >= MAX_ZOOM_RULES) throw new Error("Browser zoom preference limit reached")
  return [{ origin, factor: Math.round(factor * 100) / 100 }, ...next]
}

export function setDevicePreset(rows: BrowserDevicePreset[], input: { id?: string; name: string; size: unknown }) {
  const current = devicePresetRows(rows)
  const id = input.id ?? randomUUID()
  const next = devicePresetRows([{ id, name: input.name, size: input.size }])
  if (input.id && !current.some((row) => row.id === input.id)) throw new Error("Browser device preset changed")
  const others = current.filter((row) => row.id !== input.id)
  if (others.some((row) => row.name.toLocaleLowerCase() === next[0].name.toLocaleLowerCase()))
    throw new Error("Browser device preset name already exists")
  if (others.length >= MAX_DEVICE_PRESETS) throw new Error("Browser device preset limit reached")
  return [next[0], ...others]
}
