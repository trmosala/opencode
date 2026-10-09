import config from "./cm3.playwright.config"

export default {
  ...config,
  testMatch: "regression/cm3-scheduling.spec.ts",
  outputDir: "./test-results/scheduling",
  reporter: [["html", { outputFolder: "./playwright-report/scheduling", open: "never" }], ["line"]],
}
