import { rm, writeFile } from "node:fs/promises"

const shared: Bun.BunPlugin = {
  name: "cm-shared-safe-modules",
  setup(build) {
    build.onLoad({ filter: /opencode[\\/]src[\\/]skill[\\/]managed\.ts$/ }, async (args) => ({
      contents: (await Bun.file(args.path).text()).replaceAll("Schema.TaggedErrorClass", "Schema.TaggedError"),
      loader: "ts",
    }))
    // Bundled plugins must use this package's stable Effect, never the legacy opencode source's beta copy.
    if (build.config.target === "bun")
      build.onResolve({ filter: /^(effect|@effect\/[^/]+)(\/.*)?$/ }, (args) => ({
        path: Bun.resolveSync(args.path, import.meta.dir),
      }))
    build.onResolve({ filter: /^@opencode-ai\/core\/config\/markdown$/ }, () =>
      build.config.target === "bun"
        ? { path: Bun.resolveSync("@opencode/core/config/markdown", import.meta.dir) }
        : { path: "@opencode/core/config/markdown", external: true },
    )
  },
}

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true })
const result = await Bun.build({
  target: "node",
  conditions: ["node"],
  entrypoints: ["./src/runtime.ts", "./src/migration-reader.ts"],
  outdir: "./dist",
  format: "esm",
  splitting: true,
  sourcemap: "linked",
  external: ["effect", "@opencode/*"],
  plugins: [shared],
})
if (!result.success) throw new AggregateError(result.logs, "CookieMonster V2 runtime build failed")
console.log("CookieMonster V2 runtime built from published @opencode 2.2.5")

// Plugins run inside the official OpenCode CLI (Bun), which resolves a plugin's imports from its own directory.
// Packaged resources have no node_modules beside them, so each plugin bundles its dependencies.
const plugin = await Bun.build({
  target: "bun",
  entrypoints: ["./src/wpp-plugin.ts"],
  outdir: "./dist/wpp-plugin",
  naming: "server.js",
  format: "esm",
})
if (!plugin.success) throw new AggregateError(plugin.logs, "CookieMonster WPP plugin build failed")
await writeFile(
  "./dist/wpp-plugin/package.json",
  JSON.stringify({
    name: "@cookiemonster/wpp-runtime",
    type: "module",
    exports: { "./server": "./server.js" },
  }),
)

const features = await Bun.build({
  target: "bun",
  entrypoints: ["./src/features-plugin.ts"],
  outdir: "./dist/features-plugin",
  naming: "server.js",
  format: "esm",
  plugins: [shared],
})
if (!features.success) throw new AggregateError(features.logs, "CookieMonster features plugin build failed")
await writeFile(
  "./dist/features-plugin/package.json",
  JSON.stringify({ name: "@cookiemonster/features", type: "module", exports: { "./server": "./server.js" } }),
)

const ae = await Bun.build({
  target: "bun",
  entrypoints: ["./src/ae-plugin.ts"],
  outdir: "./dist/ae-plugin",
  naming: "server.js",
  format: "esm",
})
if (!ae.success) throw new AggregateError(ae.logs, "CookieMonster AE adapter build failed")
