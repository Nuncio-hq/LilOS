import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { AcpEngine } from "../src/engine.js";

/**
 * D-#866 — the installed-app wedge: the adapter answered `session/new`
 * never, the harness retried, and every retry orphaned another agent-side
 * child. These tests pin the fix: a bounded create wait, a process-group
 * teardown that kills the agent's whole tree, a dead connection that
 * reopens on demand, and a catalog probe that can never wedge describe().
 */

const FAKE_AGENT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "fake-agent.ts",
);
const BUN = process.env.LILOS_BUN ?? "bun";
const TIMEOUT = 600;

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Dead children go zombie until the init-reaper collects them — probe for
    gone-ness through `ps`, not `kill(0)`, which still "succeeds" on a
    reaped-pending zombie in some states. */
const gone = (pid: number): boolean => {
  const stat = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
    encoding: "utf8",
  }).stdout.trim();
  return stat === "" || stat.startsWith("Z");
};

function make(env: Record<string, string>, timeoutMs = TIMEOUT) {
  return new AcpEngine({
    name: "engine-acp-wedge-test",
    command: [BUN, FAKE_AGENT],
    env,
    createTimeoutMs: timeoutMs,
    clientInfo: { name: "lilos-wedge-test", version: "0" },
  });
}

describe("wedged agent containment (D-#866)", () => {
  test("session.start on a wedged agent errors inside the bound and kills the whole tree", {
    timeout: 30_000,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-wedge-"));
    const pidfile = join(dir, "grandchild.pid");
    const engine = make({
      LILOS_FAKE_HANG_CWD: "/tmp/wedged-cwd",
      LILOS_FAKE_GRANDCHILD_PIDFILE: pidfile,
    });
    try {
      /* describe fills the catalog via a background probe on the engine
           cwd (no wedge) so the connection is fully warm first. */
      await engine.dispatch("describe", {});
      await expect(
        engine.dispatch("session.start", {
          agent: "x",
          cwd: "/tmp/wedged-cwd",
        }),
      ).rejects.toThrow(/did not answer session\/new/);
      expect(existsSync(pidfile)).toBe(true);
      const pid = Number(readFileSync(pidfile, "utf8").trim());
      /* SIGKILL + reap race: give init a beat to collect the zombie. */
      for (let i = 0; i < 20 && !gone(pid); i++) await settle(100);
      expect(gone(pid)).toBe(true);
    } finally {
      await engine.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a dead adapter is reopened on the next demand — wedged once, then serves", {
    timeout: 30_000,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-wedge-"));
    const sentinel = join(dir, "hang-once");
    const engine = make({
      LILOS_FAKE_HANG_CWD: "/tmp/wedged-cwd",
      LILOS_FAKE_HANG_ONCE: sentinel,
    });
    try {
      await engine.dispatch("describe", {});
      await expect(
        engine.dispatch("session.start", {
          agent: "x",
          cwd: "/tmp/wedged-cwd",
        }),
      ).rejects.toThrow(/did not answer session\/new/);
      /* The wedge tore the adapter down; the next demand reopens a fresh
           one, and the sentinel keeps this generation from hanging. */
      const res = (await engine.dispatch("session.start", {
        agent: "x",
        cwd: "/tmp/wedged-cwd",
      })) as { sessionId: string };
      expect(res.sessionId).toMatch(/^s-/);
      const turn = (await engine.dispatch("prompt", {
        sessionId: res.sessionId,
        content: [{ type: "text", text: "anything" }],
      })) as { stopReason?: string };
      expect(turn.stopReason).toBeTruthy();
    } finally {
      await engine.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a wedged catalog probe blocks neither describe nor a healthy session", {
    timeout: 30_000,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-wedge-"));
    const pidfile = join(dir, "grandchild.pid");
    /* The probe session uses the engine's process.cwd() — wedge exactly
         that cwd so ONLY the probe hangs. */
    const probeCwdMark = process.cwd();
    const engine = make({
      LILOS_FAKE_HANG_CWD: probeCwdMark,
      LILOS_FAKE_GRANDCHILD_PIDFILE: pidfile,
    });
    try {
      /* r4: describe IS the supervisor's liveness probe — D-#482 runs it
           at probeTimeoutMs=1_500 with two misses restarting the adapter.
           It must answer from whatever the catalog holds, never wait on
           the probe session at all — the 8s grace starved it into a
           restart loop in the installed app. */
      const SUPERVISOR_PROBE_TIMEOUT_MS = 1_500;
      const t0 = Date.now();
      const d = await engine.dispatch("describe", {});
      expect(Date.now() - t0).toBeLessThan(SUPERVISOR_PROBE_TIMEOUT_MS);
      expect(d).toMatchObject({ name: "engine-acp-wedge-test" });
      /* A real session on a non-matching cwd works — the wedged probe
           didn't take the adapter down (fatal:false). */
      const res = (await engine.dispatch("session.start", {
        agent: "x",
        cwd: "/tmp/healthy-cwd",
      })) as { sessionId: string };
      const turn = (await engine.dispatch("prompt", {
        sessionId: res.sessionId,
        content: [{ type: "text", text: "anything" }],
      })) as { stopReason?: string };
      expect(turn.stopReason).toBeTruthy();
      /* The wedged probe's child still dies — on engine close(), via the
           same process-group teardown. */
      if (existsSync(pidfile)) {
        const pid = Number(readFileSync(pidfile, "utf8").trim());
        await engine.close();
        for (let i = 0; i < 20 && !gone(pid); i++) await settle(100);
        expect(gone(pid)).toBe(true);
      }
    } finally {
      await engine.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("close() reaps the agent's whole process group", {
    timeout: 30_000,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-wedge-"));
    const pidfile = join(dir, "grandchild.pid");
    const engine = make({
      LILOS_FAKE_HANG_CWD: "/tmp/wedged-cwd",
      LILOS_FAKE_GRANDCHILD_PIDFILE: pidfile,
    });
    try {
      await engine.dispatch("describe", {});
      const pending = engine.dispatch("session.start", {
        agent: "x",
        cwd: "/tmp/wedged-cwd",
      });
      pending.catch(() => {});
      /* Let the wedge engage (grandchild spawned), then close before the
           create bound fires — SIGTERM grace, then the group dies. */
      for (let i = 0; i < 50 && !existsSync(pidfile); i++) await settle(50);
      expect(existsSync(pidfile)).toBe(true);
      const pid = Number(readFileSync(pidfile, "utf8").trim());
      await engine.close();
      await pending.catch(() => {});
      for (let i = 0; i < 20 && !gone(pid); i++) await settle(100);
      expect(gone(pid)).toBe(true);
    } finally {
      await engine.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
