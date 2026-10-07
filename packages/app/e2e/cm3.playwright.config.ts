import config from "../playwright.config"

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4632)
process.env.PLAYWRIGHT_PORT = String(port)
process.env.PLAYWRIGHT_SERVER_PORT = String(port)

export default {
  ...config,
  testDir: ".",
  outputDir: "./test-results/cm3",
  reporter: [["html", { outputFolder: "./playwright-report/cm3", open: "never" }], ["line"]],
  testMatch: "regression/cm3-live-integration.spec.ts",
  workers: 1,
  fullyParallel: false,
  webServer: {
    timeout: 120_000,
    url: `http://127.0.0.1:${port}`,
    command: `bun run build && bun run serve -- --host 127.0.0.1 --port ${port} --strictPort`,
    reuseExistingServer: false,
    env: { VITE_OPENCODE_SERVER_HOST: "127.0.0.1", VITE_OPENCODE_SERVER_PORT: String(port) },
  },
  use: { ...config.use, baseURL: `http://127.0.0.1:${port}`, channel: "chrome" },
}
