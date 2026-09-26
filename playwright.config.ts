import { defineConfig, devices } from "@playwright/test";

/**
 * E2E smoke for the prototype: boots the vite dev server, loads the home
 * screen, and keeps a screenshot as evidence the UI renders.
 */
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5199",
    screenshot: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // --host 127.0.0.1: vite binds ::1 by default; the baseURL below is IPv4.
    command:
      "bun run --cwd prototype dev --host 127.0.0.1 --port 5199 --strictPort",
    url: "http://127.0.0.1:5199",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
