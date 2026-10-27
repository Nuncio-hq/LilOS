import { defineConfig, devices } from "@playwright/test";

/**
 * E2E: most specs boot their own stack (e2e/helpers/stack.ts) and navigate by
 * absolute URL. The v3-threads-* and v3-phone-unpair specs run against the
 * prototype's mock company instead, through the relative `baseURL` below,
 * served by the vite dev server in `webServer`.
 */
/* LILOS_PROTO_PORT moves the prototype's dev server + baseURL off 5199 —
   the escape hatch when a sibling worktree's vite already holds it (#884:
   six worktrees, one Mac; pairs with LILOS_TEST_INDEX in dev/ready.ts). */
const PROTO_PORT = Number(process.env.LILOS_PROTO_PORT ?? "5199");

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  /* Runner teardown (#347): sweep tagged stacks whose owning worker died —
     the backstop under each process's own orphan watchdog and each spec's
     afterAll. Only dead-owner tags are killed; a sibling run is never
     touched. */
  globalTeardown: "./e2e/leak-teardown.ts",
  /* CI retries a failed test once instead of re-running the whole 20-minute
     job (#201); the github reporter annotates a pass-on-retry as flaky, so it
     never goes silently green. */
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PROTO_PORT}`,
    screenshot: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // --host 127.0.0.1: vite binds ::1 by default; the baseURL above is IPv4.
    command: `bun run --cwd prototype/web dev --host 127.0.0.1 --port ${PROTO_PORT} --strictPort`,
    url: `http://127.0.0.1:${PROTO_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
