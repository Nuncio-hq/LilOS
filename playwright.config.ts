import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const repo = dirname(fileURLToPath(import.meta.url));
/* The stateful fake `gh` (issue #37) goes on the dev server's PATH; the host
   API shells out to it for forge.* calls and reads/writes e2e/.gh-fake. */
const fakeGh = join(repo, "packages/host/test/fake-gh");
const ghFakeDir = join(repo, "e2e/.gh-fake");
/* Fake Cursor/Zed bundles + a fake `open` for issue #110: os.editors sees
   them via LILOS_APP_DIRS and every launched binary logs argv to
   LILOS_OPEN_LOG (e2e/ac-110-*.spec.ts asserts on it). */
const fakeOs = join(repo, "e2e/os-fake");

/**
 * E2E smoke for the prototype: boots the vite dev server, loads the home
 * screen, and keeps a screenshot as evidence the UI renders.
 */
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  /* CI retries a failed test once instead of re-running the whole 20-minute
     job (#201); the github reporter annotates a pass-on-retry as flaky, so it
     never goes silently green. */
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5199",
    screenshot: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // --host 127.0.0.1: vite binds ::1 by default; the baseURL below is IPv4.
    command:
      "bun run --cwd prototype/web dev --host 127.0.0.1 --port 5199 --strictPort",
    url: "http://127.0.0.1:5199",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      PATH: `${fakeGh}:${join(fakeOs, "bin")}:${process.env.PATH}`,
      GH_FAKE_DIR: ghFakeDir,
      GH_FAKE_LOG: join(ghFakeDir, "gh.log"),
      LILOS_APP_DIRS: join(fakeOs, "Applications"),
      LILOS_OPEN_LOG: join(repo, "e2e/.os-fake/proto-open.log"),
    },
  },
});
