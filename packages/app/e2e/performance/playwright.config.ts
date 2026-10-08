import config from "../../playwright.config"

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000)
const outDir = process.env.OPENCODE_PERFORMANCE_BUILD_DIR
process.env.OPENCODE_PERFORMANCE_RUN_ID ??= `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`

export default {
  ...config,
  testDir: ".",
  testIgnore: "unit/**",
  outputDir: process.env.OPENCODE_PERFORMANCE_OUTPUT_DIR ?? "../test-results/performance",
  fullyParallel: false,
  workers: 1,
  reporter: [
    [
      "html",
      {
        outputFolder: process.env.OPENCODE_PERFORMANCE_REPORT_DIR ?? "../playwright-report/performance",
        open: "never",
      },
    ],
    ["line"],
  ],
  webServer: {
    ...config.webServer,
    command: `bun run build${outDir ? ` -- --outDir ${JSON.stringify(outDir)}` : ""} && bun run serve -- --host 0.0.0.0 --port ${port} --strictPort${outDir ? ` --outDir ${JSON.stringify(outDir)}` : ""}`,
    reuseExistingServer: false,
  },
}
