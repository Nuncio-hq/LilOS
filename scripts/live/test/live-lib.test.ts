/**
 * Issue #439 — the shared live-script library (`scripts/live/lib/helpers`)
 * and its typecheck coverage.
 *
 * AC-1: `bun run typecheck` covers `scripts/live` and passes — proven here
 * by the package.json wiring plus a real `tsc --listFiles` run.
 *
 * AC-2: post-#443 the only remaining `scripts/live` leg is 414.sh, which
 * needs a real `hermes serve`; the stub-mode plumbing that survives is
 * `startStub` + `openai-stub.ts` — exercised directly below — and the
 * fake-engine leg `apps/harness/scripts/demo.ts` (run for real, asserts
 * its PASS line).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cleanup,
  freePort,
  launch,
  startStub,
  waitForFile,
} from "../lib/helpers";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("AC-1 typecheck covers scripts/live and passes", () => {
  it("the root typecheck script includes scripts/live", () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.typecheck).toContain("scripts/live");
  });

  it("tsc -p scripts/live lists every live script and exits clean", () => {
    const out = execFileSync(
      "bunx",
      ["tsc", "--noEmit", "-p", "scripts/live", "--listFiles"],
      { cwd: ROOT, encoding: "utf8" },
    );
    for (const f of [
      "scripts/live/414.ts",
      "scripts/live/openai-stub.ts",
      "scripts/live/lib/helpers.ts",
    ]) {
      expect(
        out.split("\n").some((l) => l.trim().endsWith(f)),
        `typecheck program is missing ${f}`,
      ).toBe(true);
    }
  }, 120_000);
});

describe("live lib helpers", () => {
  it("freePort returns a port that binds", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    const { createServer } = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const srv = createServer();
      srv.once("error", reject);
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve()));
    });
  });

  it("waitForFile returns contents, rejects on timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lilos439-"));
    const file = join(dir, "token");
    writeFileSync(file, "  abc123\n");
    await expect(waitForFile(file, 1000)).resolves.toBe("abc123");
    await expect(waitForFile(join(dir, "nope"), 300)).rejects.toThrow(
      /timed out/,
    );
    cleanup(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("launch runs a tracked child that cleanup kills", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lilos439-"));
    const child = launch(
      "t",
      ["bun", "-e", "console.log('ok'); setInterval(()=>{},1000)"],
      {},
    );
    expect(child.pid).toBeGreaterThan(0);
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    cleanup(dir);
    await exited;
    expect(existsSync(dir)).toBe(false);
  });

  it("startStub boots openai-stub and serves the canned chat reply", async () => {
    const stub = await startStub(0);
    expect(stub.port).toBeGreaterThan(0);
    const res = await fetch(
      `http://127.0.0.1:${stub.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "stub-model", messages: [] }),
      },
    );
    const body = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(body.choices[0]?.message.content).toContain("stub engine reply");
    stub.kill();
  });
});

describe("AC-2 fake-engine leg", () => {
  it("apps/harness/scripts/demo.ts still prints PASS", () => {
    const run = spawnSync("bun", ["apps/harness/scripts/demo.ts"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 90_000,
    });
    expect(run.status, run.stderr + run.stdout).toBe(0);
    expect(run.stdout, run.stderr).toContain("PASS");
  }, 120_000);
});
