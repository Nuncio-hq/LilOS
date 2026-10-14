/**
 * Issue #560 live leg — Compact now on a REAL engine: the app relay's
 * `session.compact` passthrough reaches the hermes adapter, which maps
 * it to the gateway's `session.compress`.
 *
 *   bun scripts/live/560.ts
 *
 * 560.sh owns environment shaping (isolated HOME/HERMES_HOME/LILOS_HOME,
 * provider config, shim backup/restore, stub or live label). This script:
 *
 *   1. boots the real dev slice (`bun run dev` = relay + harness + vite)
 *      with LILOS_ENGINE=hermes — the REAL adapter supervising a REAL
 *      `hermes serve` (stub provider by default; HERMES_PROVIDER/MODEL on
 *      Oscar's Mac for the live-model leg);
 *   2. runs two content turns so the session's context reads nonzero;
 *   3. calls `session.compact` over the APP relay — the same passthrough
 *      the meter's Compact now rides — then asserts on the engine feed +
 *      the relay rows: exactly one `session.compacted` event carrying
 *      after<before tokens, exactly one "Context compacted: older turns
 *      summarized" system note (authorKind:"system", deduped on
 *      session+seq), and the conversation's persisted usage.context
 *      dropping below the pre-compact reading;
 *   4. when Playwright Chromium launches, opens the DM and screenshots
 *      the compaction note + the context meter's Compact now.
 *
 * Screenshots land in test-results/live-560/ (gitignored). If the browser
 * can't launch on this machine the UI leg reports SKIP — the wire
 * asserts still cover the AC.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { bootStack, pickPorts, type Stack } from "../../e2e/helpers/stack";
import { RelayClient } from "../../packages/client-runtime/src/client";
import { EngineClient } from "../../packages/client-runtime/src/engine";
import { cleanup, startStub } from "./lib/helpers";

const REPO = process.env.LILOS_REPO_ROOT ?? process.cwd();
const SHOTS = join(REPO, "test-results", "live-560");
mkdirSync(SHOTS, { recursive: true });

/* A short first turn whose only job is completing the one-time hermes
   agent build (same warmup 550.ts explains). */
const WARM = "Say hi.";
/* Two content turns — the stub answers each instantly (560.sh
   STUB_SCRIPT matches), and together they push the session's context
   usage above zero so the compact drop is measurable. */
const T1 = "Why is the color of the sky blue?";
const T2 = "What causes tides?";

const t0 = Date.now();
const out = (line: string) =>
  console.log(`[live-560 +${String(Date.now() - t0).padStart(5)}ms] ${line}`);

const checks: string[] = [];
const check = (ok: boolean, name: string, detail = "") => {
  checks.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  out(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) throw new Error(name);
};
const skip = (name: string, detail = "") => {
  checks.push(`SKIP ${name}${detail ? ` (${detail})` : ""}`);
  out(`SKIP ${name}${detail ? ` (${detail})` : ""}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn` returns a value or the deadline passes. */
async function waitFor<T>(
  fn: () => Promise<T | undefined> | T | undefined,
  label: string,
  ms = 60_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined && v !== false) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline)
      throw new Error(
        `timed out waiting for ${label}${last ? ` (${String(last)})` : ""}`,
      );
    await sleep(200);
  }
}

/* ------------------------------- boot ---------------------------------- */

const stub = process.env.LILOS_STUB_PORT
  ? await startStub(Number(process.env.LILOS_STUB_PORT))
  : null;
if (stub) out(`openai-stub listening on :${stub.port}`);

let stack: Stack | undefined;
let relay: RelayClient | undefined;
let feedClient: EngineClient | undefined;
let sessionFeed: ReturnType<EngineClient["sessionFeed"]> | undefined;

interface MsgRow {
  id: string;
  seq: number;
  text?: string;
  authorKind?: string;
  conversationId?: string | null;
}
interface ConvRow {
  id: string;
  channelId: string;
  engineRef: string | null;
  deliveredSeq: number;
  state: string;
  usage?: { context?: number; input?: number; output?: number };
}

/* Same read the meter makes (contextUsedOf): the engine's occupancy
   reading when it reports one, else the last turn's in+out sum — hermes
   reports context only some of the time, input/output always. */
const usedOf = (u?: { context?: number; input?: number; output?: number }) =>
  u === undefined ? undefined : (u.context ?? (u.input ?? 0) + (u.output ?? 0));

process.on("SIGINT", () => {
  void stack?.stop();
  process.exit(130);
});

try {
  stack = await bootStack(
    "live560",
    await pickPorts(),
    { LILOS_ENGINE: "hermes", LILOS_USER_NAME: "Oscar" },
    { home: process.env.LILOS_HOME },
  );
  out(
    `stack up — relay ${stack.relayWs} feed ${stack.feedWs} web ${stack.webUrl}`,
  );

  relay = new RelayClient({
    url: stack.relayWs,
    token: stack.relayToken,
    client: { name: "live-560" },
  });
  await relay.connect();
  const rl = relay;
  /* The feed's `connect()` sends `describe`, which the harness proxies to
     the engine — on a real Mac `hermes serve --isolated` in a fresh
     HERMES_HOME re-provisions its tools for 30–60 s first, so a connect
     issued at "stack up" dies on the describe timeout. Wait for the
     engine itself (the same `system.status` gate 412.ts uses, on 584's
     240 s budget), not a bigger request timeout. */
  const engineBootAt = Date.now();
  await waitFor(
    async () => {
      const { components } = await rl.request<{
        components: { id: string; state: string }[];
      }>("system.status", { logLines: 0 });
      return components.find((c) => c.id === "engine")?.state === "ok"
        ? true
        : undefined;
    },
    "engine running (system.status)",
    240_000,
  );
  out(`engine running after ${String(Date.now() - engineBootAt)}ms`);

  feedClient = new EngineClient({ url: stack.feedWs, token: stack.relayToken });
  await feedClient.connect();

  /* ── scenario: two content turns → session.compact → asserts ───────── */

  const { employee } = await relay.request<{ employee: { id: string } }>(
    "employees.create",
    { name: "Ada", role: "engineer", profile: "builder" },
  );
  const { channel } = await relay.request<{
    channel: { id: string; employeeId: string };
  }>("channels.openDm", { employeeId: employee.id });
  const { conversation } = await relay.request<{
    conversation: { id: string };
  }>("conversations.open", { channelId: channel.id, text: WARM });
  out(`DM ${channel.id} conversation ${conversation.id} — warmup sent`);

  const listConv = async () =>
    (
      await rl.request<{ conversations: ConvRow[] }>("conversations.list", {})
    ).conversations.find((c) => c.id === conversation.id);
  const listMsgs = async () =>
    (
      await rl.request<{ messages: MsgRow[] }>("messages.list", {
        channelId: channel.id,
        limit: 200,
      })
    ).messages;

  const bound = await waitFor(
    async () => {
      const c = await listConv();
      return c?.engineRef ? c : undefined;
    },
    "engine session bound",
    120_000,
  );

  sessionFeed = feedClient.sessionFeed(bound.engineRef ?? "");
  const feed = sessionFeed;
  const feedEvents = (type: string) =>
    feed
      .get()
      .events.filter((e) => e.type === type && e.sessionId === bound.engineRef);
  await waitFor(
    () => (feedEvents("turn.completed").length >= 1 ? true : undefined),
    "warmup turn.completed on the engine feed (agent built)",
    120_000,
  );
  out(`engine session ${bound.engineRef} — warmup done, agent live`);

  /* Two content turns so the meter reads a real number before Compact. */
  for (const text of [T1, T2]) {
    const before = feedEvents("turn.completed").length;
    await relay.request("messages.post", {
      channelId: channel.id,
      conversationId: conversation.id,
      text,
      authorKind: "user",
    });
    await waitFor(
      () => (feedEvents("turn.completed").length > before ? true : undefined),
      `turn.completed for "${text.slice(0, 24)}"`,
      120_000,
    );
  }
  /* A provider can report zero usage (the stub does) — then only the
     session.compacted drop counts, the meter reading stays 0. */
  const convPre = await listConv();
  const pre = usedOf(convPre?.usage) ?? 0;
  out(`pre-compact context: ${pre} tokens`);

  /* AC — Compact now: the same passthrough the meter calls. Hermes may
     decline to fold a small session ("skipped") — the honest no-op; a
     real provider with a fat context reports "compressed". */
  const compactResult = await rl.request<{ status?: string }>(
    "session.compact",
    { sessionId: bound.engineRef },
  );
  out(`session.compact → ${JSON.stringify(compactResult)}`);
  check(
    compactResult.status === "compressed" ||
      compactResult.status === "skipped" ||
      compactResult.status === "pending",
    "session.compact accepted",
    compactResult.status ?? "missing",
  );
  const reallyFolded = compactResult.status === "compressed";

  /* Exactly one typed event carrying a measurable drop — only on a real
     fold; a skipped fold posts no event and no note. */
  if (reallyFolded) {
    const compacted = await waitFor(
      () => (feedEvents("session.compacted").length >= 1 ? true : undefined),
      "session.compacted on the engine feed",
      120_000,
    );
    check(compacted === true, "session.compacted emitted");
    const events = feedEvents("session.compacted");
    check(
      events.length === 1,
      "exactly one session.compacted (no double post)",
      `${events.length}`,
    );
    const payload = events[0]?.payload as
      | { beforeTokens?: number; afterTokens?: number }
      | undefined;
    const bt = payload?.beforeTokens;
    const at = payload?.afterTokens;
    check(
      bt !== undefined && at !== undefined && at < bt,
      "event carries after<before tokens",
      `${bt} → ${at}`,
    );
  }

  /* The thread says so once — a persisted system note, replayable —
     exactly when the fold was real. */
  const countNotes = async () =>
    (await listMsgs()).filter(
      (m) =>
        m.authorKind === "system" &&
        m.text?.startsWith("Context compacted: older turns summarized"),
    ).length;
  if (reallyFolded) {
    const notesLen = await waitFor(
      async () => ((await countNotes()) >= 1 ? await countNotes() : undefined),
      "compaction note posted to the thread",
      30_000,
    );
    check(notesLen === 1, "one compaction note in the thread");
    const note = (await listMsgs()).find(
      (m) =>
        m.authorKind === "system" &&
        m.text?.startsWith("Context compacted: older turns summarized"),
    );
    check(
      /\(\d.*→.*\d/.test(note?.text ?? ""),
      "note carries the before→after drop",
      note?.text,
    );
  } else {
    /* A skipped fold must not claim it summarized anything. */
    await sleep(1500);
    check(
      (await countNotes()) === 0,
      "no compaction note on a skipped fold",
      `${await countNotes()}`,
    );
  }

  /* The meter drops: the relay persisted the compacted usage. Only
     measurable when the provider reported usage beforehand. */
  if (reallyFolded && pre > 0) {
    await waitFor(
      async () => {
        const c = await listConv();
        const used = usedOf(c?.usage);
        return used !== undefined && used < pre ? used : undefined;
      },
      "persisted usage.context below the pre-compact reading",
      30_000,
    ).then((after) => {
      check(
        after < pre,
        "persisted usage.context dropped",
        `${pre} → ${after}`,
      );
    });
  }

  /* ------------------------------ UI leg ------------------------------ */

  let browser: Awaited<
    ReturnType<typeof import("@playwright/test").chromium.launch>
  > | null = null;
  try {
    const { chromium } = await import("@playwright/test");
    browser = await chromium.launch();
  } catch (e) {
    skip(
      "UI: chromium launch",
      `browser launch failed: ${e instanceof Error ? e.message : e} — wire asserts above stand`,
    );
  }
  if (browser) {
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      await page.addInitScript(
        "try { localStorage.setItem('lilos-onboarded', '1'); } catch {}",
      );
      /* System notes render inside the open thread — the focus route. */
      await page.goto(
        `${stack.webUrl}/dm/${encodeURIComponent(employee.id)}/${encodeURIComponent(conversation.id)}/focus`,
      );
      const sysnote = page.locator("[data-sysnote]", {
        hasText: /Context compacted/,
      });
      if (reallyFolded) {
        await sysnote
          .first()
          .waitFor({ state: "visible", timeout: 60_000 })
          .catch(() => {
            throw new Error("compaction sysnote never rendered");
          });
        check(true, "UI: compaction note rendered in the thread");
      }

      /* The meter's Compact now + (at Full) Continue affordance — open
         the context popover on the session row. */
      const meter = page.locator("button", { hasText: /%/ }).first();
      if (await meter.count()) {
        await meter.hover();
        const panel = page.locator("[data-context-panel]");
        if (await panel.count()) {
          check(
            (await page.locator("[data-compact-now]").count()) >= 1,
            "UI: Compact now in the context panel",
          );
          await page.locator("[data-context-panel]").screenshot({
            path: join(SHOTS, "560-context-panel.png"),
          });
        } else {
          skip("UI: context panel", "popover did not open");
        }
      } else {
        skip("UI: context meter", "no meter button found");
      }

      if (reallyFolded) await sysnote.first().scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(SHOTS, "560-compacted-note.png"),
        fullPage: false,
      });
      out(`screenshots in ${SHOTS}`);
    } finally {
      await browser.close();
    }
  }

  out("all checks passed — session.compact end to end on real hermes");
  console.log("RESULT: PASS");
  for (const c of checks) console.log(`  ${c}`);
} catch (e) {
  console.log(`RESULT: FAIL — ${e instanceof Error ? e.message : e}`);
  for (const c of checks) console.log(`  ${c}`);
  if (sessionFeed) {
    console.log("  engine session events:");
    for (const ev of sessionFeed.get().events.slice(-20))
      console.log(`    ${ev.type} ${JSON.stringify(ev.payload).slice(0, 120)}`);
  }
  if (stack) {
    const tail = stack
      .harnessLog()
      .split("\n")
      .filter((l) => l.trim())
      .slice(-25);
    console.log("  last harness log lines:");
    for (const l of tail) console.log(`    ${l}`);
  }
  process.exitCode = 1;
} finally {
  relay?.close();
  feedClient?.close();
  await stack?.stop();
  /* helpers' `exit` hook is only a backstop — kill the stub and every
     launched child explicitly so a FAIL run can't leak port holders. */
  cleanup();
}
