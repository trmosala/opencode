import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import electron from "electron"

const directory = await mkdtemp(join(tmpdir(), "cm-browser-smoke-"))
try {
  if (process.argv.includes("--account-fill")) {
    const { build } = await import("vite")
    const { createRequire } = await import("node:module")
    const require = createRequire(resolve("../app/package.json"))
    const { default: solid } = await import(require.resolve("vite-plugin-solid"))
    await build({
      configFile: false,
      root: resolve("../app"),
      plugins: [
        {
          name: "account-fill-fixture",
          enforce: "pre",
          resolveId(id) {
            const name = ["@/context/language", "@/context/platform", "@/context/prompt", "@/utils/toast"].find(
              (name) =>
                id === name || id.replaceAll("\\", "/") === resolve("../app/src", name.slice(2)).replaceAll("\\", "/"),
            )
            if (name) return "\0fixture:" + name
          },
          load(id) {
            if (id === "\0fixture:@/context/language")
              return `import { dict } from ${JSON.stringify(resolve("../app/src/i18n/en.ts"))}; export const useLanguage = () => ({ t: key => dict[key] ?? key })`
            if (id === "\0fixture:@/context/platform")
              return "export const usePlatform = () => ({ browserPanel: window.fixture.browser })"
            if (id === "\0fixture:@/context/prompt") return "export const usePrompt = () => ({})"
            if (id === "\0fixture:@/utils/toast") return "export const showToast = () => window.fixture.errors++"
          },
        },
        solid(),
      ],
      resolve: { alias: { "@": resolve("../app/src") } },
      build: {
        outDir: directory,
        emptyOutDir: false,
        minify: false,
        lib: {
          entry: resolve("../app/test-browser/browser-account-fill.fixture.tsx"),
          formats: ["iife"],
          name: "AccountFillFixture",
          fileName: () => "account-fill.js",
        },
      },
    })
  }
  const build = await Bun.build({
    entrypoints: ["./src/main/browser/native-smoke.ts"],
    target: "node",
    format: "cjs",
    external: ["electron"],
  })
  if (!build.success) throw new Error(build.logs.join("\n"))
  const entry = join(directory, "native.cjs")
  await Bun.write(entry, build.outputs[0])
  const env = { ...process.env, CM_BROWSER_STATE_DIR: directory, CM_BROWSER_SMOKE_PROFILE: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const child = Bun.spawn([electron, entry, ...process.argv.slice(2)], { env, stdout: "inherit", stderr: "inherit" })
  const timeout = setTimeout(
    () => child.kill(),
    process.argv.includes("--registration") ||
      process.argv.includes("--offer-patterns") ||
      process.env.CM_BROWSER_LIVE_SMOKE === "1"
      ? 120_000
      : 60_000,
  )
  const code = await child.exited
  clearTimeout(timeout)
  console.log(
    "Last stage:",
    await Bun.file(join(directory, "stage.txt"))
      .text()
      .catch(() => "entry not reached"),
  )
  const result = await Bun.file(join(directory, "result.txt"))
    .text()
    .catch(() => "")
  if (code !== 0 || result !== "PASS")
    throw new Error(`Native smoke exited ${code}: ${result || "no completion result"}`)
  console.log("PASS native browser smoke")
} finally {
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("cm-browser-smoke-"))
    throw new Error("Unexpected browser smoke directory")
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
