import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(here, "../plugin/lilos/__init__.py");
const PROBE = join(here, "lilos_plugin_probe.py");

/**
 * #411 AC-4 — plugin registration must not be able to block on the
 * gateway. A socket that accepts and never answers is the shape of the
 * harness event-loop freeze that burned Hermes' 10 s plugin-load deadline:
 * pre-fix `register()` sat inside `urlopen(GET /tools)` for its full 15 s
 * timeout and returned zero tools; the snapshot read can't wait at all.
 */
let hung: Server;
let port: number;

beforeAll(async () => {
  hung = createServer(() => {});
  await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
  port = (hung.address() as { port: number }).port;
});

afterAll(() => hung.close());

test("register() returns fast with the full catalog against a dead gateway", () => {
  const r = spawnSync("python3", [PROBE, PLUGIN], {
    env: {
      ...process.env,
      LILOS_SURFACES_URL: `http://127.0.0.1:${port}`,
      LILOS_ENGINE_TOKEN: "test-token",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  const out = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}") as {
    seconds: number;
    tools: string[];
  };
  /* Generous bound for slow CI: the old path needed the whole 15 s urllib
     timeout; the snapshot path is a file read well under a second. */
  expect(out.seconds).toBeLessThan(5);
  expect(out.tools).toContain("lilos_context");
  expect(out.tools).toContain("lilos_team_list");
  expect(out.tools.length).toBeGreaterThanOrEqual(20);
});

test("#549 AC-2: browser_exec/browser_vault_* get a truthful block inside a LilOS session", () => {
  const r = spawnSync("python3", [PROBE, PLUGIN, "--gate"], {
    env: {
      ...process.env,
      LILOS_SURFACES_URL: `http://127.0.0.1:${port}`,
      LILOS_ENGINE_TOKEN: "test-token",
      // The acp path's LilOS-source stamp — serve sessions bind it per
      // session; the probe's env mark is equivalent for the gate.
      HERMES_SESSION_SOURCE: "lilos",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  const out = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}") as {
    browser_exec: string | null;
    browser_vault_fill: string | null;
    lilos_context: string | null;
  };
  /* browser_exec has a LilOS alternative — the message must name it. */
  expect(out.browser_exec).toBeTruthy();
  expect(out.browser_exec).toContain("lilos_browser_");
  /* browser_vault_* has NO LilOS alternative today — the message must say
     so instead of pointing at tools that don't exist (AC-2). */
  expect(out.browser_vault_fill).toBeTruthy();
  expect(out.browser_vault_fill).toContain("no lilos_* alternative");
  /* A lilos_* tool on a lilos session is not gated. */
  expect(out.lilos_context).toBeNull();
});
