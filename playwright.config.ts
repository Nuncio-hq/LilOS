import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const repo = dirname(fileURLToPath(import.meta.url));
/* The stateful fake `gh` (issue #37) goes on the dev server's PATH; the host
   API shells out to it for forge.* calls and reads/writes e2e/.gh-fake. */
const fakeGh = join(repo, "packages/host/test/fake-gh");
const ghFakeDir = join(repo, "e2e/.gh-fake");

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
    env: {
      PATH: `${fakeGh}:${process.env.PATH}`,
      GH_FAKE_DIR: ghFakeDir,
      GH_FAKE_LOG: join(ghFakeDir, "gh.log"),
    },
  },
});
