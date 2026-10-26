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
 * child. r6 review: a per-session timeout must NOT tear the shared
 * adapter down — it multiplexes every live session over one process
 * group, so the "fix" SIGKILLed healthy turns and left other sessions
 * prompting a stale id (the reviewer's poison.ts). These tests pin the
 * new contract: the wedged call alone errors, live sessions keep
 * serving, an adapter DEATH marks every session suspended so the next
 * use re-creates it, and close() still reaps the whole group.
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
  test("a wedged session/new abandons that call and keeps serving live sessions", {
    timeout: 30_000,
  }, async () => {
    /* The reviewer's poison.ts, as a unit test: session A healthy,
       session B's session/new wedges past the bound — A must NOT then
       fail with "Internal error" (the old teardown left A prompting a
       stale id on a fresh adapter). */
    const dir = mkdtempSync(join(tmpdir(), "acp-wedge-"));
    const pidfile = join(dir, "grandchild.pid");
    const engine = make({
      LILOS_FAKE_HANG_CWD: "/tmp/wedged-cwd",
      LILOS_FAKE_GRANDCHILD_PIDFILE: pidfile,
    });
    try {
      await engine.dispatch("describe", {});
      const a = (await engine.dispatch("session.start", {
        agent: "x",
        cwd: "/tmp/healthy-cwd",
      })) as { sessionId: string };
      const t1 = (await engine.dispatch("prompt", {
        sessionId: a.sessionId,
        content: [{ type: "text", text: "first" }],
      })) as { stopReason?: string };
      expect(t1.stopReason).not.toBe("refusal");
      /* B wedges past the bound — its start errors; A's adapter must
         still be alive, and A's next turn must still answer. */
      await expect(
        engine.dispatch("session.start", {
          agent: "x",
          cwd: "/tmp/wedged-cwd",
        }),
      ).rejects.toThrow(/did not answer session\/new/);
      const t2 = (await engine.dispatch("prompt", {
        sessionId: a.sessionId,
        content: [{ type: "text", text: "after the wedge" }],
      })) as { stopReason?: string };
      expect(t2.stopReason).not.toBe("refusal");
      /* The wedged session's grandchild is NOT killed by the timeout —
         the adapter's group only dies at close(). */
      expect(existsSync(pidfile)).toBe(true);
      const pid = Number(readFileSync(pidfile, "utf8").trim());
      await engine.close();
      for (let i = 0; i < 20 && !gone(pid); i++) await settle(100);
      expect(gone(pid)).toBe(true);
    } finally {
      await engine.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a dead adapter marks sessions suspended — the next prompt re-creates on the fresh adapter", {
    timeout: 30_000,
  }, async () => {
    /* Adapter DEATH is the other half of the contract: sessions holding
       stale ACP ids must re-create via resume, not refuse. engine.close()
       is the deterministic death here (a crash takes the same path via
       the proc exit handler). */
    const dir = mkdtempSync(join(tmpdir(), "acp-wedge-"));
    const metaLog = join(dir, "meta.log");
    const engine = make({
      LILOS_FAKE_META_LOG: metaLog,
    });
    try {
      await engine.dispatch("describe", {});
      const a = (await engine.dispatch("session.start", {
        agent: "x",
        cwd: "/tmp/healthy-cwd",
      })) as { sessionId: string };
      await engine.dispatch("prompt", {
        sessionId: a.sessionId,
        content: [{ type: "text", text: "before" }],
      });
      /* Adapter dies; sessions are marked suspended — the next demand
         spawns a fresh adapter whose sessions table is empty, so the
         resume falls back to session/new (observable in the meta log). */
      await engine.close();
      await engine.dispatch("describe", {});
      const turn = (await engine.dispatch("prompt", {
        sessionId: a.sessionId,
        content: [{ type: "text", text: "after" }],
      })) as { stopReason?: string };
      expect(turn.stopReason).not.toBe("refusal");
      const ops = readFileSync(metaLog, "utf8")
        .trim()
        .split("\n")
        .map((l) => (JSON.parse(l) as { op: string }).op);
      /* new (catalog probe) + new (A) + the re-create after death. */
      expect(ops.filter((o) => o === "new").length).toBeGreaterThanOrEqual(3);
    } finally {
      await engine.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a wedged session.start inside the budget still leaves the adapter usable", {
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
      /* The wedged call is abandoned on the SAME adapter — the sentinel
         means this generation now serves normally, no respawn needed. */
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

  test("close() still group-kills when the adapter already exited — a TERM-ignoring child cannot orphan", {
    timeout: 30_000,
  }, async () => {
    /* The reviewer's close-orphan.ts: the adapter exits 0 (SIGTERM
       grace satisfied) while a session child ignores TERM — the old
       close() read the proc's exit code and skipped the group SIGKILL,
       leaving the child reparented to launchd. Unix-only — the repro
       needs signal dispositions. */
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "acp-wedge-"));
    const pidfile = join(dir, "ignoring.pid");
    const engine = make({
      LILOS_FAKE_TERM_IGNORING_PIDFILE: pidfile,
      LILOS_FAKE_EXIT_AFTER_MS: "1500",
    });
    try {
      await engine.dispatch("describe", {});
      /* The TERM-ignoring grandchild is up; the adapter exits 0 on its
         own — wait for both so close() runs with exitCode already set. */
      for (let i = 0; i < 50 && !existsSync(pidfile); i++) await settle(50);
      expect(existsSync(pidfile)).toBe(true);
      const pid = Number(readFileSync(pidfile, "utf8").trim());
      await settle(2_000);
      /* close() must still reach the group — the grandchild cannot
         outlive the connection that owned it. */
      await engine.close();
      for (let i = 0; i < 20 && !gone(pid); i++) await settle(100);
      expect(gone(pid)).toBe(true);
    } finally {
      await engine.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session.start's chain cannot outrun the start budget — slow writes land as notes inside the bound", {
    timeout: 30_000,
  }, async () => {
    /* r7: the harness waits 60s on session.start; an unbounded chain
       (newSession + config writes + set_mode at 45s each) could finish
       after the bind already failed, orphaning the session + child.
       With a small startBudgetMs and a slow config write, the start
       must answer inside the budget — the starved pick as a note, the
       session itself still live. */
    const dir = mkdtempSync(join(tmpdir(), "acp-wedge-"));
    const engine = new AcpEngine({
      name: "engine-acp-wedge-test",
      command: [BUN, FAKE_AGENT],
      env: { LILOS_FAKE_SLOW_CONFIG_MS: "800" },
      createTimeoutMs: 2_000,
      startBudgetMs: 400,
      clientInfo: { name: "lilos-wedge-test", version: "0" },
    });
    try {
      await engine.dispatch("describe", {});
      const t0 = Date.now();
      const res = (await engine.dispatch("session.start", {
        agent: "x",
        cwd: "/tmp/slow-cfg",
        model: "fake-deep",
      })) as { sessionId: string; notes?: string[] };
      const elapsed = Date.now() - t0;
      /* The write was starved by the budget — answered inside it, as a
         note, not after a 2s RPC timeout tail. */
      expect(elapsed).toBeLessThan(1_500);
      expect((res.notes ?? []).join(" ")).toMatch(/Skipped model "fake-deep"/);
      /* And the session still works — the budget degraded a pick,
         not the session. */
      const turn = (await engine.dispatch("prompt", {
        sessionId: res.sessionId,
        content: [{ type: "text", text: "hi" }],
      })) as { stopReason?: string };
      expect(turn.stopReason).toBeTruthy();
    } finally {
      await engine.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
