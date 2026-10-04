import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #482 — a dead `hermes serve` behind a live adapter must not leave the
 * engine looking `running` while every call hangs 15 s.
 *
 * Boots the real `bun run dev` stack with `HERMES_BIN` pointing at a wrapper
 * around `e2e/fake-hermes.ts` (a Bun WS server speaking the real gateway
 * protocol, writing its own pid to HERMES_FAKE_PID_FILE and stored sessions
 * to HERMES_FAKE_STATE_FILE).
 *
 *   AC-1: `kill -9` on the hermes child → within 5 s the harness reports the
 *         engine not-running (`system.status` engine component leaves `ok`,
 *         a `host.changed` broadcast carries the engine state) and in-flight
 *         + new engine calls fail fast with a typed `engine_unavailable`.
 *   AC-2: the adapter relaunches Hermes itself → `models.list` answers again
 *         and the SAME DM conversation answers via `session.resume`
 *         (state file's `resumes` proves the stored ref was reused).
 *   AC-3: System status dialog shows the outage while it lasts (driven by
 *         making the relaunched fake fail on demand via FAKE_SERVE_FAIL_FILE).
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-482");
const BUN = process.env.BUN_BIN ?? "/Users/devin/.bun/bin/bun";

/** `hermes` wrapper → `bun e2e/fake-hermes.ts "$@"`. */
function fakeHermesBin(dir: string): string {
  const bin = path.join(dir, "hermes");
  writeFileSync(
    bin,
    `#!/bin/sh\nexec ${BUN} ${path.join(here, "fake-hermes.ts")} "$@"\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

interface Frame {
  jsonrpc?: string;
  id?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

/** Persistent relay client: request map + notification capture. */
class RelayProbe {
  readonly events: Frame[] = [];
  private ws!: WebSocket;
  private pending = new Map<
    string,
    {
      res: (f: Frame) => void;
      rej: (e: Error) => void;
    }
  >();
  private n = 0;

  static async connect(relayWs: string, token: string): Promise<RelayProbe> {
    const p = new RelayProbe();
    p.ws = new WebSocket(relayWs);
    await new Promise<void>((res, rej) => {
      p.ws.onopen = () => res();
      p.ws.onerror = () => rej(new Error("relay ws connect failed"));
    });
    p.ws.onmessage = (e) => {
      const f = JSON.parse(String(e.data)) as Frame;
      if (typeof f.id === "string" && (f.result !== undefined || f.error)) {
        const w = p.pending.get(f.id);
        if (w) {
          p.pending.delete(f.id);
          f.error
            ? w.rej(
                Object.assign(new Error(`${f.error.message}`), {
                  rpc: f.error,
                }),
              )
            : w.res(f);
        }
      } else if (typeof f.method === "string") p.events.push(f);
    };
    await p.call("session.hello", { protocolVersion: 1, token });
    return p;
  }

  call(method: string, params: Record<string, unknown>): Promise<Frame> {
    const id = `q${this.n++}`;
    return new Promise<Frame>((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** The appCode the app would read off an error frame (data.code). */
  async appCode(
    method: string,
    params: Record<string, unknown>,
  ): Promise<string | undefined> {
    try {
      await this.call(method, params);
      return undefined;
    } catch (e) {
      return (e as { rpc?: { data?: { code?: string } } }).rpc?.data?.code;
    }
  }

  waitEvent(
    method: string,
    pred: (params: unknown) => boolean,
    timeoutMs: number,
  ): Promise<Frame> {
    const found = this.events.find(
      (f) => f.method === method && pred(f.params),
    );
    if (found) return Promise.resolve(found);
    return new Promise<Frame>((res, rej) => {
      const t = setTimeout(
        () =>
          rej(new Error(`no ${method} matching pred within ${timeoutMs}ms`)),
        timeoutMs,
      );
      const poll = setInterval(() => {
        const hit = this.events.find(
          (f) => f.method === method && pred(f.params),
        );
        if (hit) {
          clearTimeout(t);
          clearInterval(poll);
          res(hit);
        }
      }, 25);
    });
  }

  /** system.status engine component state (ok/connecting/degraded/down/blocked). */
  async engineState(): Promise<{ state: string; reason: string }> {
    const f = await this.call("system.status", { logLines: 0 });
    const comp = (
      f.result as {
        components: { id: string; state: string; reason: string }[];
      }
    ).components.find((c) => c.id === "engine");
    if (!comp) throw new Error("system.status has no engine component");
    return comp;
  }

  close() {
    this.ws.close();
  }
}

const waitFor = async (
  fn: () => Promise<boolean>,
  timeoutMs: number,
  everyMs = 100,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline)
      throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
};

async function waitPidFile(file: string, timeoutMs = 30_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(file)) {
      const pid = Number(readFileSync(file, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    if (Date.now() > deadline)
      throw new Error("hermes pid file never appeared");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test.describe.configure({ mode: "serial" });

test("AC-1/2/3 (#482) killed hermes child → typed errors fast, outage shown, self-heals", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const scratch = mkdtempSync(path.join(tmpdir(), "lilos-482-"));
  const pidFile = path.join(scratch, "hermes.pid");
  const stateFile = path.join(scratch, "state.json");
  const serveFailFile = path.join(scratch, "serve-fail");
  const bin = fakeHermesBin(scratch);
  const stack: Stack = await bootStack("e482", await pickPorts(), {
    LILOS_ENGINE: "hermes",
    HERMES_BIN: bin,
    HERMES_FAKE_PID_FILE: pidFile,
    HERMES_FAKE_STATE_FILE: stateFile,
    FAKE_SERVE_FAIL_FILE: serveFailFile,
  });
  const probe = await RelayProbe.connect(stack.relayWs, stack.relayToken);
  try {
    /* ── baseline: engine up, DM answers ─────────────────────────── */
    await waitFor(
      async () => (await probe.engineState()).state === "ok",
      60_000,
    );
    const [created] = await Promise.all([
      probe.call("employees.create", {
        name: "Default",
        role: "Founder's engineer",
        profile: "default",
        status: "online",
      }),
    ]);
    const employeeId = (created.result as { employee: { id: string } }).employee
      .id;
    const dm = await probe.call("channels.openDm", { employeeId });
    const channelId = (dm.result as { channel: { id: string } }).channel.id;
    await probe.call("channel.subscribe", { channelId });

    const opened = await probe.call("conversations.open", {
      channelId,
      authorId: "user",
      authorKind: "user",
      text: "pre-kill ping",
    });
    const conversationId = (opened.result as { conversation: { id: string } })
      .conversation.id;
    const answered = probe.waitEvent(
      "message.created",
      (p) =>
        (p as { message?: { authorKind?: string; conversationId?: string } })
          ?.message?.authorKind === "employee",
      60_000,
    );
    await answered; // baseline turn lands → engine session + stored ref exist

    /* ── AC-1: in-flight + new calls fail fast & typed; outage reported ── */
    const pid = await waitPidFile(pidFile);
    const held = probe.call("models.list", { refresh: true });
    const heldError = held.then(
      () => "resolved",
      (e: Error & { rpc?: Frame["error"] }) => e.rpc?.data?.code,
    );
    // An in-flight TURN too: the fake never completes HOLD_TURN text.
    await probe.call("messages.post", {
      channelId,
      conversationId,
      authorId: "user",
      authorKind: "user",
      text: "HOLD_TURN — the watchdog should kill this turn",
    });

    const killAt = Date.now();
    process.kill(pid, "SIGKILL");

    // In-flight request fails typed within 5 s.
    const inFlightCode = await Promise.race([
      heldError,
      new Promise<string>((_, rej) =>
        setTimeout(
          () => rej(new Error("held models.list never settled")),
          5_000,
        ),
      ),
    ]);
    expect(inFlightCode, "in-flight request error code").toBe(
      "engine_unavailable",
    );
    const inFlightMs = Date.now() - killAt;
    expect(inFlightMs).toBeLessThan(5_000);

    // A NEW call hits a dead backend → fast typed error, not a 15 s hang.
    const newCode = await probe.appCode("models.list", {});
    expect(newCode).toBe("engine_unavailable");
    expect(Date.now() - killAt).toBeLessThan(5_000);

    // Harness reports the engine not-running within 5 s of the kill.
    const outageBroadcast = probe.waitEvent(
      "host.changed",
      (p) =>
        (p as { engine?: { state?: string } }).engine !== undefined &&
        (p as { engine: { state: string } }).engine.state !== "running",
      5_000 - (Date.now() - killAt) > 0 ? 5_000 - (Date.now() - killAt) : 1,
    );
    const statusFlipped = waitFor(
      async () => (await probe.engineState()).state !== "ok",
      Math.max(1, 5_000 - (Date.now() - killAt)),
      100,
    );
    await Promise.all([outageBroadcast, statusFlipped]);

    /* ── AC-2: adapter relaunches Hermes; sessions resume on their ref ── */
    await waitFor(
      async () => (await probe.engineState()).state === "ok",
      60_000,
    );
    const relist = await probe.call("models.list", {});
    expect(
      (relist.result as { models: unknown[] }).models.length,
    ).toBeGreaterThan(0);

    const afterAnswer = probe.waitEvent(
      "message.created",
      (p) => {
        const m = (p as { message?: { authorKind?: string; text?: string } })
          .message;
        return (
          m?.authorKind === "employee" &&
          typeof m.text === "string" &&
          m.text.includes("post-kill ping")
        );
      },
      60_000,
    );
    await probe.call("messages.post", {
      channelId,
      conversationId,
      authorId: "user",
      authorKind: "user",
      text: "post-kill ping",
    });
    await afterAnswer;
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as {
      resumes: { requested: string; ref: string }[];
      sessions: Record<string, unknown>;
    };
    expect(
      state.resumes.length,
      "engine resumed the stored session (memory kept)",
    ).toBeGreaterThanOrEqual(1);
    for (const r of state.resumes)
      expect(Object.keys(state.sessions)).toContain(r.ref);

    /* ── AC-3: System status shows the outage while it lasts ── */
    // Make the fake refuse `serve` so the relaunch loop holds the outage.
    writeFileSync(serveFailFile, "1");
    const pid2 = await waitPidFile(pidFile);
    process.kill(pid2, "SIGKILL");
    await probe.waitEvent(
      "host.changed",
      (p) =>
        (p as { engine?: { state?: string } }).engine?.state === "restarting",
      10_000,
    );
    await page.goto(`${stack.webUrl}/dm/${employeeId}?statusPollMs=500`);
    await page.getByRole("button", { name: "System status" }).click();
    const dialog = page.getByRole("dialog", { name: "System status" });
    const engineRow = dialog
      .locator("li, div, p")
      .filter({ hasText: /^Engine/ })
      .first();
    await expect(engineRow).toBeVisible({ timeout: 30_000 });
    await expect(engineRow).not.toContainText("ok");
    await page.screenshot({ path: `${SHOTS}/ac-3-status-outage.png` });

    // Let it heal again for the harness-log tail assertion.
    await page.getByRole("button", { name: "System status" }).press("Escape");
    await page
      .goto(`${stack.webUrl}/dm/${employeeId}?statusPollMs=500`)
      .catch(() => undefined);
    const { unlinkSync } = await import("node:fs");
    unlinkSync(serveFailFile);
    await waitFor(
      async () => (await probe.engineState()).state === "ok",
      60_000,
    );

    const log = stack.harnessLog();
    expect(log).toMatch(/engine state.*(restarting|backend)/);
    expect(log).toMatch(/hermes backend/);
  } finally {
    probe.close();
    await stack.stop();
    const { unlinkSync } = await import("node:fs");
    if (existsSync(serveFailFile)) unlinkSync(serveFailFile);
  }
});
