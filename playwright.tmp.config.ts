import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  globalTeardown: "./e2e/leak-teardown.ts",
  reporter: [["list"]],
  use: { screenshot: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
