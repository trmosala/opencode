import { expect, test } from "bun:test"
import { compile } from "tailwindcss"

test("color utilities read scoped theme tokens at the styled element", async () => {
  const compiler = await compile(`${await Bun.file(import.meta.dir + "/colors.css").text()}\n@tailwind utilities;`)
  const css = compiler.build([
    "bg-v2-background-bg-base",
    "text-text-weak",
    "border-border-base",
    "bg-v2-background-bg-layer-02/60",
  ])
  expect(css).toContain("background-color: var(--v2-background-bg-base)")
  expect(css).toContain("color: var(--text-weak)")
  expect(css).toContain("border-color: var(--border-base)")
  expect(css).toContain("color-mix(in oklab, var(--v2-background-bg-layer-02) 60%, transparent)")
})
