import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * AC-1/AC-4/AC-5 real-driver leg (issue #36): the script must run under Bun
 * (the PTY is Bun.spawn's `terminal`), so vitest — which runs under Node —
 * shells out. Requires playwright chromium (`bunx playwright install
 * chromium`, already in CI) and a POSIX shell.
 */
const SCRIPT = fileURLToPath(
  new URL("../scripts/surfaces-e2e.ts", import.meta.url),
);

describe("AC-1/AC-4/AC-5 real harness surfaces", () => {
  it("drives real Chromium + real PTY, viewer takeover works", () => {
    const run = spawnSync("bun", [SCRIPT], {
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env },
    });
    if (run.status !== 0)
      console.error(run.stdout, run.stderr, run.error?.message);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/surfaces-e2e: \d+\/\d+ passed/);
    expect(run.stdout).not.toContain("FAIL ");
  }, 150_000);
});
