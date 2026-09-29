/**
 * Issue #182 live leg: the plan/task-list flows the mobile thread renders —
 * driven end-to-end over the real relay + harness so every assertion travels
 * the phone's own routes (`session.events`, `asks.list`, `asks.respond`,
 * `messages.list`, `conversations.open`).
 *
 * Driven by scripts/live/182.sh:
 *   fake (default) — engine-fake plan scripts: `plan: tasks`, `plan: propose`
 *          (v1 -> Change -> v2 -> Approve ticks steps; a second conv Reject)
 *   hermes — the live/stub Hermes leg: capability + `kind:"tasks"` streaming
 *          only. engine-hermes has no plan-proposal surface (no ask of
 *          kind "plan"), so the decide legs skip by design.
 *
 * Asserts:
 *   1. welcome.engineHost + engine describe declare the `plan` capability,
 *   2. `plan: tasks` streams plan.updated and finishes steps completed,
 *   3. propose -> open plan ask -> change -> v1 replaced + v2 waiting,
 *      approve -> steps tick to done, asks drain,
 *   4. propose -> reject -> turn ends, plan rejected, no ask left open,
 *   5. `session.events` replay rebuilds both versions (phone's restore path).
 *
 * Exits 0 only when every check for the chosen engine passes.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EngineClient,
  RelayClient,
  reduceSessionEvents,
} from "@lilos/client-runtime";
import type {
  AppMessage,
  Ask,
  Conversation,
  SystemStatusResult,
  WelcomeResult,
} from "@lilos/contracts/app";
import type { EngineEvent, EventsSinceResult } from "@lilos/contracts/engine";

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const seconds = Number(process.env.LILOS_LIVE_SECONDS ?? "180");
const engineKind = process.env.LILOS_ENGINE ?? "fake";

const out = (line: string) => console.log(`[live-182] ${line}`);
const fail = (line: string): never => {
  console.error(`[live-182] FAIL ${line}`);
  try {
    console.error(readFileSync(join(harnessHome, "harness.log"), "utf8"));
  } catch {
    /* no log file */
  }
  cleanup();
  process.exit(1);
};

const freePort = async () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() =>
        typeof addr === "object" && addr
          ? resolve(addr.port)
          : reject(new Error("no port")),
      );
    });
  });

const relayPort = await freePort();
const feedPort = await freePort();
const relayHome = mkdtempSync(join(tmpdir(), "lilos182-relay-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos182-harness-"));

const procs: ChildProcess[] = [];
const launch = (name: string, cmd: string[], env: Record<string, string>) => {
  const child = spawn(cmd[0] ?? "bun", cmd.slice(1), {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(child);
  child.stdout?.on("data", (d) =>
    String(d)
      .trimEnd()
      .split("\n")
      .forEach((l) => {
        console.log(`  [${name}] ${l}`);
      }),
  );
  child.stderr?.on("data", (d) =>
    String(d)
      .trimEnd()
      .split("\n")
      .forEach((l) => {
        console.error(`  [${name}!] ${l}`);
      }),
  );
  return child;
};
const cleanup = () => {
  for (const p of procs) p.kill("SIGTERM");
  rmSync(relayHome, { recursive: true, force: true });
  rmSync(harnessHome, { recursive: true, force: true });
};
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

launch("relay", ["bun", "apps/relay/src/index.ts"], {
  LILOS_RELAY_HOME: relayHome,
  LILOS_RELAY_PORT: String(relayPort),
});
const waitForFile = async (path: string, ms = 15_000): Promise<string> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return fail(`timed out waiting for ${path}`);
};
const relayToken = await waitForFile(join(relayHome, "relay-token"));
const relayUrl = `ws://127.0.0.1:${relayPort}/ws`;

{
  const deadline = Date.now() + 15_000;
  for (;;) {
    const ok = await fetch(`http://127.0.0.1:${relayPort}/`, {
      signal: AbortSignal.timeout(1_000),
    })
      .then(() => true)
      .catch(() => false);
    if (ok) break;
    if (Date.now() > deadline) fail("relay never listened");
    await new Promise((r) => setTimeout(r, 200));
  }
}

launch("harness", ["bun", "apps/harness/src/index.ts"], {
  LILOS_RELAY_URL: relayUrl,
  LILOS_RELAY_TOKEN: relayToken,
  LILOS_HARNESS_HOME: harnessHome,
  LILOS_WORKDIR: join(harnessHome, "work"),
  LILOS_FEED_PORT: String(feedPort),
  LILOS_ENGINE: engineKind,
  LILOS_REPO_ROOT: repoRoot,
});
out(`harness launched with LILOS_ENGINE=${engineKind}`);

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-182", version: "0" },
});
const welcome: WelcomeResult = await user
  .connect()
  .catch((e) => fail(`connect: ${e}`));
const feed = new EngineClient({ url: `ws://127.0.0.1:${feedPort}/ws` });

const waitFor = async <T>(
  what: string,
  poll: () => Promise<T | undefined>,
  ms = seconds * 1000,
): Promise<T> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await poll();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  return fail(`timed out waiting for ${what}`);
};

// ── engine leg comes up ─────────────────────────────────────────────────
const status = await waitFor("engine leg", async () => {
  const s = await user
    .request<SystemStatusResult>("system.status", {})
    .catch(() => ({}) as SystemStatusResult);
  const eng = s.engine;
  const leg = s.components?.find((c) => c.id === "engine");
  return eng?.name && leg?.state === "ok" ? s : undefined;
});
if (engineKind === "fake" && status.engine?.name !== "engine-fake")
  fail(`expected engine-fake, got ${status.engine?.name}`);
if (engineKind === "hermes" && status.engine?.name === "engine-fake")
  fail("engine leg reports engine-fake — expected engine-hermes");
out(`engine leg: ${status.engine?.name}`);

// ── 1: the plan capability is declared where the phone gates on it ──────
const desc = await feed.connect().catch((e) => fail(`feed connect: ${e}`));
if (!desc.capabilities.some((c) => c.id === "plan"))
  fail(
    `engine did not declare 'plan': ${desc.capabilities.map((c) => c.id).join(", ")}`,
  );
/* The phone reads welcome.engineHost.capabilities at connect — a welcome
   taken before the harness registered has none. Reconnect now that the
   engine leg is up; that's the steady state a phone actually sees. */
const user2 = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-182-b", version: "0" },
});
const welcome2 = await user2.connect().catch((e) => fail(`reconnect: ${e}`));
user2.close();
const welcomeCap = welcome2.engineHost?.capabilities?.some(
  (c) => c.id === "plan",
);
if (!welcomeCap)
  fail(
    `welcome.engineHost.capabilities lacks 'plan' after engine registration (first connect: ${JSON.stringify(welcome.engineHost)}) — the mobile gate (D-#19) would hide every plan card`,
  );
out("plan capability declared (engine describe + relay welcome)");

// ── helpers over the phone's own routes ─────────────────────────────────
const sessionEvents = async (conversationId: string) =>
  user
    .request<EventsSinceResult>("session.events", { conversationId, after: 0 })
    .catch(() => undefined);

const turnModelOf = (conversationId: string, res: EventsSinceResult) =>
  /* Events carry the engine sessionId, not the conversationId — take it
     from the replay snapshot (always present) or the events themselves. */
  reduceSessionEvents(
    res.snapshot.sessionId ??
      res.events.find((e) => e.sessionId)?.sessionId ??
      conversationId,
    res.events,
    { state: res.snapshot.state },
  ).turns;

const asksFor = async (conversationId: string) => {
  const { asks } = await user.request<{ asks: Ask[] }>("asks.list", {
    conversationId,
  });
  return asks;
};
const openPlanAsk = async (conversationId: string) =>
  waitFor("an open plan ask", async () =>
    (await asksFor(conversationId)).find(
      (a) => a.state === "open" && a.request.kind === "plan",
    ),
  );
const respond = (askId: string, outcome: string, answer?: string) =>
  user
    .request("asks.respond", { askId, outcome, answer })
    .catch((e) => fail(`asks.respond ${outcome}: ${e}`));

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: "Ada 182", role: "engineer", profile: "builder" },
);
const { channel } = await user.request<{ channel: { id: string } }>(
  "channels.openDm",
  { employeeId: employee.id },
);
const openTurn = async (text: string, title: string) => {
  const { conversation } = await user.request<{
    conversation: Conversation;
  }>("conversations.open", { channelId: channel.id, text, title });
  return conversation;
};
const employeeReplies = async (conversationId: string) => {
  const { messages } = await user.request<{ messages: AppMessage[] }>(
    "messages.list",
    { channelId: channel.id },
  );
  return messages.filter(
    (m) =>
      m.conversationId === conversationId &&
      m.authorKind === "employee" &&
      m.authorId !== "system",
  );
};

// ── 2: a tasks list streams plan.updated and finishes completed (AC-1) ──
const tasksConv = await openTurn(
  engineKind === "fake"
    ? "plan: tasks"
    : (process.env.LILOS_LIVE_PROMPT ??
        "Keep a todo list with 3 items for reorganising the readme — mark each in_progress then completed as you go."),
  "#182 tasks",
);
const tasksRes = await waitFor("the tasks turn to finish", async () => {
  const res = await sessionEvents(tasksConv.id);
  return res?.events.some((e) => e.type === "turn.completed") ? res : undefined;
});
const tasksTurn = [...turnModelOf(tasksConv.id, tasksRes).values()].at(-1);
const tasksPlan = tasksTurn?.plans.at(-1);
const tasksUpdates = tasksRes.events.filter(
  (e): e is Extract<EngineEvent, { type: "plan.updated" }> =>
    e.type === "plan.updated" && e.payload.kind === "tasks",
);
if (!tasksUpdates.length) fail("no plan.updated kind=tasks events");
if ((tasksPlan?.steps.length ?? 0) < 2)
  fail(`task list too small (${tasksPlan?.steps.length} steps)`);
if (tasksPlan?.steps.some((s) => !s.text.trim()))
  fail("a plan.updated step has empty text");
/* engine-fake ticks every step to completed before the turn ends; a live
   engine may finish its answer mid-list (or leave it ticking) — the card
   asserts the stream + reply, not a fully-green board. */
if (engineKind === "fake") {
  if (tasksPlan?.status !== "approved")
    fail(`tasks plan status ${tasksPlan?.status} — expected approved at done`);
  if (tasksPlan?.steps.some((s) => s.status !== "completed"))
    fail("tasks turn finished with uncompleted steps");
}
await waitFor("the tasks reply", async () =>
  (await employeeReplies(tasksConv.id)).at(-1),
);
out(`tasks list ticked ${tasksUpdates.length}x and folded done`);

if (engineKind !== "fake") {
  /* engine-hermes streams todo -> kind:"tasks" only; it has no plan ask,
     so the propose/change/reject legs are engine-fake territory. */
  cleanup();
  console.log(
    `RESULT: PASS (${status.engine?.name}: plan cap + tasks streaming; propose/decide legs need engine-fake — run without LILOS_ENGINE for those)`,
  );
  process.exit(0);
}

// ── 3: propose -> Change -> v2 -> Approve -> done (AC-2/AC-3/AC-4) ──────
const propConv = await openTurn("plan: propose", "#182 propose");
const v1Ask = await openPlanAsk(propConv.id);
out("v1 proposed and waiting (plan ask open — Needs you)");

await respond(v1Ask.id, "change", "keep the steps, tighten the risks");
const v2Ask = await waitFor("v2 proposed and waiting", async () => {
  const res = await sessionEvents(propConv.id);
  const turn = res && [...turnModelOf(propConv.id, res).values()].at(-1);
  const asks = await asksFor(propConv.id);
  const open = asks.find((a) => a.state === "open");
  if (
    turn?.plans.length === 2 &&
    turn.plans[0]?.status === "replaced" &&
    turn.plans[1]?.status === "proposed" &&
    open?.request.kind === "plan"
  )
    return open;
});
out("v1 replaced by v2, v2 waiting");

await respond(v2Ask.id, "approve");
const approvedRes = await waitFor("the approved plan to finish", async () => {
  const res = await sessionEvents(propConv.id);
  return res?.events.some((e) => e.type === "turn.completed") ? res : undefined;
});
const approvedTurn = [...turnModelOf(propConv.id, approvedRes).values()].at(-1);
if (
  approvedTurn?.plans.length !== 2 ||
  approvedTurn.plans[0]?.status !== "replaced" ||
  approvedTurn.plans[1]?.status !== "approved" ||
  approvedTurn.plans[1]?.steps.some((s) => s.status !== "completed")
)
  fail(
    `approve leg wrong: ${JSON.stringify(approvedTurn?.plans.map((p) => [p.version, p.status]))}`,
  );
if ((await asksFor(propConv.id)).some((a) => a.state === "open"))
  fail("an ask is still open after approve finished");
if (approvedRes.openRequests.length)
  fail("events.since still reports open requests");
await waitFor("the approve reply", async () =>
  (await employeeReplies(propConv.id)).at(-1),
);
out("approved: v2 steps ticked to done, asks drained, reply posted");

// ── 4: propose -> Reject stops it (AC-2) ────────────────────────────────
const rejConv = await openTurn("plan: propose", "#182 reject");
const rejAsk = await openPlanAsk(rejConv.id);
await respond(rejAsk.id, "reject");
const rejRes = await waitFor("the rejected turn to end", async () => {
  const res = await sessionEvents(rejConv.id);
  return res?.events.some((e) => e.type === "turn.completed") ? res : undefined;
});
const rejTurn = [...turnModelOf(rejConv.id, rejRes).values()].at(-1);
if (rejTurn?.plans.at(-1)?.status !== "rejected")
  fail(`reject leg: plan status ${rejTurn?.plans.at(-1)?.status}`);
if ((await asksFor(rejConv.id)).some((a) => a.state === "open"))
  fail("reject left an ask open");
out("rejected: plan marked rejected, ask resolved, turn ended");

// ── 5: replay rebuilds every version (AC-5 restore path) ────────────────
const replay = await sessionEvents(propConv.id);
const replayedTurn =
  replay && [...turnModelOf(propConv.id, replay).values()].at(-1);
if (
  replayedTurn?.plans.length !== 2 ||
  replayedTurn.plans[0]?.status !== "replaced" ||
  replayedTurn.plans[1]?.status !== "approved"
)
  fail("session.events replay did not rebuild both plan versions");
out("replay rebuilds v1(replaced) + v2(approved) — the phone's restore path");

cleanup();
console.log(
  `RESULT: PASS (engine-fake over real relay+harness: tasks ticks, propose->Change->v2->Approve->done, Reject stops, replay restores)`,
);
process.exit(0);
