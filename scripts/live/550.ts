/**
 * Issue #550 live leg — a steer the real engine already LANDED must stay
 * out of the not-sent tray when the turn is Stopped, and the "Stopped."
 * note must never render as a user-style bubble.
 *
 *   bun scripts/live/550.ts
 *
 * 550.sh owns environment shaping (isolated HOME/HERMES_HOME/LILOS_HOME,
 * provider config, shim backup/restore, stub or live label). This script:
 *
 *   1. boots the real dev slice (`bun run dev` = relay + harness + vite)
 *      with LILOS_ENGINE=hermes — the REAL adapter supervising a REAL
 *      `hermes serve` (stub provider by default; HERMES_PROVIDER/MODEL on
 *      Oscar's Mac for the live-model leg);
 *   2. drives the issue's scenario over the relay wire: DM a task, hold
 *      the turn (stub delayMs / real model latency), send the steer, wait
 *      for `turn.steered` on the engine feed — engine-hermes emits it
 *      inside `session.steer`, so on a real engine the landing ALWAYS
 *      outruns the ack: the exact window engine-fake's ack-then-land
 *      order never produced;
 *   3. presses Stop (`turns.interrupt`) and asserts: the steered message
 *      stays delivered (`dropped` falsy, visible) and the stop note posts
 *      `authorKind:"system"` — the wire shape of "no tray row, no user
 *      bubble". NOTE on real hermes every accepted steer lands before its
 *      ack — an accepted-but-unlanded steer (AC-2's park case) exists only
 *      on engines that land later; that path is unit-tested, not
 *      reproducible here;
 *   4. when Playwright Chromium launches, opens the DM and asserts the
 *      rendered state — landed steer chip inside the turn, no
 *      `[data-notsent]` tray, no `[data-userturn]` "Stopped." bubble, the
 *      stop note rendered as a muted sysnote — and screenshots it.
 *
 * Screenshots land in test-results/live-550/ (gitignored). If the browser
 * can't launch on this machine the UI leg reports SKIP — the wire asserts
 * still cover AC-1/AC-3 state; the screenshot is then the coordinator's
 * piece on Oscar's Mac.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { bootStack, pickPorts, type Stack } from "../../e2e/helpers/stack";
import { RelayClient } from "../../packages/client-runtime/src/client";
import { EngineClient } from "../../packages/client-runtime/src/engine";
import { cleanup, startStub } from "./lib/helpers";

const REPO = process.env.LILOS_REPO_ROOT ?? process.cwd();
const SHOTS = join(REPO, "test-results", "live-550");
mkdirSync(SHOTS, { recursive: true });

/* A short first turn whose only job is completing the one-time hermes
   agent build: between `session.create` and the build finishing, the
   gateway runs turns with `running=true, agent=None` and `session.steer`
   answers 4010 → the steer queues instead of landing (verified
   2026-10-06 — turn.started + session.state running on the feed, still
   no turn.steered). Once any turn completed, the agent exists and a
   mid-turn steer lands like Oscar's real one. */
const WARM = "Say hi.";
/* The task prompts the stub's held reply (550.sh STUB_SCRIPT match) or a
   long real-model answer — either way the turn is running when the steer
   lands. The steer text is the issue's verbatim message. */
const TASK = "Write a detailed essay about the sea.";
const STEER = "Actually make it about the ocean instead.";

const t0 = Date.now();
const out = (line: string) =>
  console.log(`[live-550 +${String(Date.now() - t0).padStart(5)}ms] ${line}`);

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
let channelId: string | undefined;

interface MsgRow {
  id: string;
  seq: number;
  text?: string;
  dropped?: boolean;
  authorKind?: string;
  conversationId?: string | null;
}
interface ConvRow {
  id: string;
  channelId: string;
  engineRef: string | null;
  deliveredSeq: number;
  state: string;
}

process.on("SIGINT", () => {
  void stack?.stop();
  process.exit(130);
});

try {
  /* The real dev slice: relay + harness (LILOS_ENGINE=hermes → the real
     adapter + a real `hermes serve` child) + vite. */
  stack = await bootStack(
    "live550",
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
    client: { name: "live-550" },
  });
  await relay.connect();
  const rl = relay;
  feedClient = new EngineClient({ url: stack.feedWs });
  await feedClient.connect();

  /* ── scenario: task → steer mid-turn → Stop ─────────────────────────── */

  // The DM + employee exist before the UI leg needs them (idempotent on
  // the harness's first-run hire).
  const { employee } = await relay.request<{ employee: { id: string } }>(
    "employees.create",
    { name: "Ada", role: "engineer", profile: "builder" },
  );
  const { channel } = await relay.request<{
    channel: { id: string; employeeId: string };
  }>("channels.openDm", { employeeId: employee.id });
  channelId = channel.id;
  const { conversation } = await relay.request<{
    conversation: { id: string };
  }>("conversations.open", { channelId: channel.id, text: WARM });
  out(`DM ${channel.id} conversation ${conversation.id} — warmup sent`);

  const listConv = async () =>
    (
      await rl.request<{ conversations: ConvRow[] }>("conversations.list", {})
    ).conversations.find((c) => c.id === conversation.id);
  const listMsgs = async (includeDropped = false) =>
    (
      await rl.request<{ messages: MsgRow[] }>("messages.list", {
        channelId: channel.id,
        limit: 200,
        ...(includeDropped ? { includeDropped: true } : {}),
      })
    ).messages;

  /* Wait for the engine session to exist (engineRef on the
     conversation), then for the warmup turn to complete — the latter
     proves the hermes-side agent is built, which is what makes the
     following task turn steerable. Feed events are the gate everywhere
     in this script: the harness fans each event to feed subscribers
     before it updates the binding, and both run synchronously inside one
     dispatch tick, so a feed-visible event is already applied. */
  const bound = await waitFor(
    async () => {
      const c = await listConv();
      return c?.engineRef ? c : undefined;
    },
    "engine session bound",
    120_000,
  );

  // The engine feed records every engine event — the landed steer MUST be
  // in this session's log (and the harness must have kept it out of the
  // tray when the ack arrived after it).
  sessionFeed = feedClient.sessionFeed(bound.engineRef ?? "");
  const feed = sessionFeed;
  const feedHas = (type: string, text?: string) =>
    feed
      .get()
      .events.some(
        (e) =>
          e.type === type &&
          (text === undefined ||
            (e.payload as { text?: string }).text === text),
      );
  const feedCount = (type: string) =>
    feed.get().events.filter((e) => e.type === type).length;
  await waitFor(
    () => (feedHas("turn.completed") ? true : undefined),
    "warmup turn.completed on the engine feed (agent built)",
    120_000,
  );
  out(`engine session ${bound.engineRef} — warmup done, agent live`);

  /* The task — its turn is held open by the stub's 90 s reply (or a real
     model's thinking) while the steer arrives. */
  const { message: task } = await relay.request<{ message: MsgRow }>(
    "messages.post",
    {
      channelId: channel.id,
      conversationId: conversation.id,
      text: TASK,
      authorKind: "user",
    },
  );
  await waitFor(
    () => (feedCount("turn.started") >= 2 ? true : undefined),
    "task turn.started on the engine feed",
    120_000,
  );
  out(`task posted (seq ${task.seq}) — turn running`);

  // The steer, mid-turn.
  const { message: steer } = await relay.request<{ message: MsgRow }>(
    "messages.post",
    {
      channelId: channel.id,
      conversationId: conversation.id,
      text: STEER,
      authorKind: "user",
    },
  );
  out(`steer posted (seq ${steer.seq})`);

  /* AC-1's real order: `turn.steered` lands on the feed BEFORE the
     `session.steer` ack advances deliveredSeq — see it first, then see the
     ack. (The live check's screenshot showed the "steered —" chip before
     Stop; this is the same proof on the wire.) */
  await waitFor(
    () => feedHas("turn.steered", STEER) || undefined,
    "turn.steered on the engine feed",
    60_000,
  );
  check(true, "turn.steered landed on the engine feed", `"${STEER}"`);
  await waitFor(
    async () => {
      const c = await listConv();
      return c && c.deliveredSeq >= steer.seq ? c : undefined;
    },
    "steer ack delivered",
    60_000,
  );

  // Stop — the issue's Esc.
  await relay.request("turns.interrupt", { conversationId: conversation.id });
  out("turns.interrupt sent");

  /* Settle: turn.completed on the feed, the conversation back to idle.
     The Stop sweep itself is deferred on the harness's per-conversation
     chain — the 2 s grace covers those few localhost writes; the tray
     assertions below hold at relay state, not at a lucky instant. */
  await waitFor(
    () => (feedCount("turn.completed") >= 2 ? true : undefined),
    "turn.completed on the engine feed",
    90_000,
  );
  await waitFor(
    async () => {
      const c = await listConv();
      return c && c.state === "idle" ? c : undefined;
    },
    "conversation idle",
    60_000,
  );
  await sleep(2_000);
  out("turn ended; conversation idle");

  /* ── wire asserts ───────────────────────────────────────────────────── */

  const all = await listMsgs(true);
  const visible = await listMsgs();
  const steerRow = all.find((m) => m.id === steer.id);
  check(
    !!steerRow && !steerRow.dropped,
    "AC-1 landed steer never parked: row not dropped",
    steerRow ? `dropped=${String(steerRow.dropped)}` : "row missing",
  );
  check(
    visible.some((m) => m.id === steer.id),
    "AC-1 landed steer still a visible message",
  );
  /* No other row may be parked either: this run has exactly one steer and
     it landed — a stray drop of anything else is the same bug. */
  const parked = all.filter(
    (m) => m.dropped && m.conversationId === conversation.id,
  );
  check(
    parked.length === 0,
    "AC-1 not-sent tray empty for this conversation",
    parked.map((m) => `"${(m.text ?? "").slice(0, 40)}"`).join(", "),
  );

  /* The "Stopped." note: posted only when the cancelled turn streamed no
     answer. On the stub it always posts; on a live model that answered
     first it may not — AC-3 allows "or not at all". When it exists it
     MUST be a system note: `authorKind:"system"` is the wire shape the UI
     renders as a muted note, never a user bubble. */
  const stopNote = all.find(
    (m) =>
      m.authorKind === "system" &&
      m.conversationId === conversation.id &&
      /Stopped\./.test(m.text ?? ""),
  );
  const anyNote = all.find(
    (m) =>
      m.conversationId === conversation.id && /Stopped\./.test(m.text ?? ""),
  );
  if (anyNote) {
    check(
      !!stopNote,
      "AC-3 stop note posts as authorKind:system (not user)",
      `authorKind=${anyNote.authorKind ?? "?"}`,
    );
  } else {
    check(
      true,
      "AC-3 no stop note posted (turn answered before Stop) — nothing to render",
    );
  }

  /* ── UI leg: the rendered thread + screenshot ───────────────────────── */

  let browser:
    | Awaited<ReturnType<typeof import("@playwright/test").chromium.launch>>
    | undefined;
  try {
    const { chromium } = await import("@playwright/test");
    browser = await chromium.launch();
  } catch (e) {
    skip(
      "UI leg (Playwright Chromium)",
      `browser launch failed: ${e instanceof Error ? e.message : e} — wire asserts above stand; screenshot must come from a machine with browsers installed`,
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
      await page.goto(
        `${stack.webUrl}/dm/${encodeURIComponent(employee.id)}/${encodeURIComponent(conversation.id)}`,
      );

      const uiWait = async (sel: string, label: string, ms = 60_000) =>
        page
          .locator(sel)
          .first()
          .waitFor({ state: "visible", timeout: ms })
          .then(() => undefined)
          .catch(() => {
            throw new Error(`timed out waiting for ${label}`);
          });

      /* The turn renders settled with the landed steer chip inside it —
         "Oscar steered — …" — and the "Stopped · session.interrupt" end
         chip. Give vite a beat for first compile + the feed attach. */
      await uiWait(
        "[data-agentturn] [data-turnsettled]",
        "settled turn",
        120_000,
      );
      const landed = page.locator('[data-steerstate="landed"]', {
        hasText: /ocean/i,
      });
      check(
        (await landed.count()) >= 1,
        "UI: landed steer chip inside the turn",
        `${await landed.count()} landed chips`,
      );

      /* AC-1 in the render: no not-sent tray at all — the run's only
         steer landed, so there is nothing to park. */
      await sleep(1_500); // settle: the tray derives from the same state
      check(
        (await page.locator("[data-notsent]").count()) === 0,
        "UI: not-sent tray absent",
        `${await page.locator("[data-notsent]").count()} trays`,
      );
      check(
        (await page
          .locator("[data-userturn]", { hasText: /ocean/i })
          .count()) === 0,
        "UI: steer renders once (chip), not as a second user bubble",
      );

      /* AC-3 in the render: no right-aligned user bubble for the stop
         note; when the note posted it renders as the muted sysnote. */
      check(
        (await page
          .locator("[data-userturn]", { hasText: /Stopped|⚠/ })
          .count()) === 0,
        'UI: no user-style "Stopped." bubble',
      );
      if (stopNote) {
        const sysnote = page.locator("[data-sysnote]", {
          hasText: /Stopped/,
        });
        check(
          (await sysnote.count()) >= 1,
          "UI: stop note renders as a muted system note",
          `${await sysnote.count()} sysnotes`,
        );
      } else {
        check(true, "UI: no stop note posted — nothing to render");
      }
      await page.locator("[data-agentturn]").last().scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(SHOTS, "550-after-stop.png"),
        fullPage: false,
      });
      out(`screenshot ${join(SHOTS, "550-after-stop.png")}`);
    } catch (e) {
      check(false, "UI leg", e instanceof Error ? e.message : String(e));
    } finally {
      await browser.close().catch(() => {});
    }
  }

  out("all checks passed — landed steer survived the Stop");
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
  if (relay && channelId) {
    try {
      const { messages } = await relay.request<{ messages: MsgRow[] }>(
        "messages.list",
        { channelId, limit: 200, includeDropped: true },
      );
      console.log("  wire messages:");
      for (const m of messages.slice(-10))
        console.log(
          `    seq=${m.seq} kind=${m.authorKind} dropped=${m.dropped ?? false} ${JSON.stringify((m.text ?? "").slice(0, 60))}`,
        );
    } catch {}
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
