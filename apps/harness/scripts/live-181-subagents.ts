/**
 * Issue #181 live leg: subagents + background jobs in a mobile thread —
 * driven end-to-end over the real relay + harness so every assertion travels
 * the phone's own routes (`session.events`, `jobs.list`, `jobs.stop`,
 * `messages.list`, `conversations.open`, relay `welcome`).
 *
 * Driven by scripts/live/181.sh:
 *   fake (default) — engine-fake #179 scripts: `delegate` (3 helpers, middle
 *          fails; `@mention` tags the last as an employee-helper),
 *          `LILOS_BG`/dev server (long-running job until jobs.stop).
 *   hermes — the live/stub Hermes leg: capability declarations + whichever
 *          of the subagent/job legs the engine produces for the same prompts
 *          (delegation/jobs come from its own runtime; asserted loosely).
 *
 * Asserts:
 *   1. engine describe + relay welcome declare `subagents`/`background_jobs`
 *      (the phone's D-#19 gate),
 *   2. delegate turn → 3 subagents on the turn model: done/failed/done with
 *      steps, result and durationMs (AC-1),
 *   3. `@reviewer delegate` → last helper carries
 *      employee {employeeRef:"reviewer", sessionRef: reviewer's live
 *      session} — the row opens that thread (AC-2),
 *   4. `LILOS_BG run a dev server` → job.started + job.output stream, the job
 *      stays running after the turn; `jobs.list` agrees; `jobs.stop` →
 *      job.exited stopped + `jobs.list` shows it stopped (AC-3),
 *   5. `session.events` replay rebuilds subagents + the job with no
 *      duplicates (AC-4 restore path),
 *   6. harness relaunched against a genuinely cap-less engine
 *      (LILOS_ENGINE=command + serve.ts --no-cap) → a fresh welcome no
 *      longer declares either capability — the gate input disappears (AC-5).
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
  Conversation,
  SystemStatusResult,
  WelcomeResult,
} from "@lilos/contracts/app";
import type { EventsSinceResult, Job } from "@lilos/contracts/engine";

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const seconds = Number(process.env.LILOS_LIVE_SECONDS ?? "180");
const engineKind = process.env.LILOS_ENGINE ?? "fake";

const out = (line: string) => console.log(`[live-181] ${line}`);
const fail = (line: string): never => {
  console.error(`[live-181] FAIL ${line}`);
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
const relayHome = mkdtempSync(join(tmpdir(), "lilos181-relay-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos181-harness-"));

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

const launchHarness = (extraEnv: Record<string, string> = {}) =>
  launch("harness", ["bun", "apps/harness/src/index.ts"], {
    LILOS_RELAY_URL: relayUrl,
    LILOS_RELAY_TOKEN: relayToken,
    LILOS_HARNESS_HOME: harnessHome,
    LILOS_WORKDIR: join(harnessHome, "work"),
    LILOS_FEED_PORT: String(feedPort),
    LILOS_ENGINE: engineKind,
    LILOS_REPO_ROOT: repoRoot,
    ...extraEnv,
  });
launchHarness();
out(`harness launched with LILOS_ENGINE=${engineKind}`);

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-181", version: "0" },
});
await user.connect().catch((e) => fail(`connect: ${e}`));
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

const freshWelcome = async (tag: string): Promise<WelcomeResult> => {
  const c = new RelayClient({
    url: relayUrl,
    token: relayToken,
    client: { name: tag, version: "0" },
  });
  const w = await c.connect().catch((e) => fail(`welcome ${tag}: ${e}`));
  c.close();
  return w;
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

// ── 1: both capabilities are declared where the phone gates on them ──────
const desc = await feed.connect().catch((e) => fail(`feed connect: ${e}`));
for (const cap of ["subagents", "background_jobs"])
  if (!desc.capabilities.some((c) => c.id === cap))
    fail(
      `engine did not declare '${cap}': ${desc.capabilities.map((c) => c.id).join(", ")}`,
    );
/* The phone reads welcome.engineHost.capabilities at connect — a welcome
   taken before the harness registered has none. Take a fresh one now. */
const welcome2 = await freshWelcome("lilos-live-181-b");
for (const cap of ["subagents", "background_jobs"])
  if (!welcome2.engineHost?.capabilities?.some((c) => c.id === cap))
    fail(
      `welcome.engineHost.capabilities lacks '${cap}' after engine registration (${JSON.stringify(welcome2.engineHost)}) — the mobile gate (D-#19) would hide the pill + sheets`,
    );
out("subagents + background_jobs declared (engine describe + relay welcome)");

// ── helpers over the phone's own routes ─────────────────────────────────
const sessionEvents = async (conversationId: string) =>
  user
    .request<EventsSinceResult>("session.events", { conversationId, after: 0 })
    .catch(() => undefined);

const sessionModelOf = (conversationId: string, res: EventsSinceResult) =>
  /* Events carry the engine sessionId, not the conversationId — take it
     from the replay snapshot (always present) or the events themselves. */
  reduceSessionEvents(
    res.snapshot.sessionId ??
      res.events.find((e) => e.sessionId)?.sessionId ??
      conversationId,
    res.events,
    { state: res.snapshot.state },
  );

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: "Ada 181", role: "engineer", profile: "default" },
);
const { channel } = await user.request<{ channel: { id: string } }>(
  "channels.openDm",
  { employeeId: employee.id },
);
const openTurn = async (
  text: string,
  title: string,
  channelId = channel.id,
) => {
  const { conversation } = await user.request<{
    conversation: Conversation;
  }>("conversations.open", { channelId, text, title });
  return conversation;
};
const finished = async (conv: Conversation) =>
  waitFor(`turn to finish (${conv.id})`, async () => {
    const res = await sessionEvents(conv.id);
    return res?.events.some((e) => e.type === "turn.completed")
      ? res
      : undefined;
  });
/* conversations.open answers a snapshot taken before the harness attaches
   engineRef — poll conversations.list for the live row. */
const liveConv = async (conv: Conversation) =>
  waitFor(`engineRef for ${conv.id}`, async () => {
    const { conversations } = await user
      .request<{ conversations: Conversation[] }>("conversations.list", {})
      .catch(() => ({ conversations: [] as Conversation[] }));
    const c = conversations.find((x) => x.id === conv.id);
    return c?.engineRef ? c : undefined;
  });
const employeeReplies = async (conversationId: string, channelId: string) => {
  const { messages } = await user.request<{ messages: AppMessage[] }>(
    "messages.list",
    { channelId },
  );
  return messages.filter(
    (m) =>
      m.conversationId === conversationId &&
      m.authorKind === "employee" &&
      m.authorId !== "system",
  );
};

// ── 2: delegate turn → 3 helpers done/failed/done (AC-1) ────────────────
const delConv = await openTurn(
  engineKind === "fake"
    ? "delegate this"
    : (process.env.LILOS_LIVE_DELEGATE_PROMPT ??
        "Delegate this to three subagents and report back."),
  "#181 delegate",
);
const delRes = await finished(delConv);
const delTurn = sessionModelOf(delConv.id, delRes).turns.at(-1);
const subs = delTurn?.subagents ?? [];
if (engineKind === "fake" && !subs.length)
  fail("delegate turn produced no subagents");
if (engineKind !== "fake" && !subs.length)
  out(
    "live engine produced no subagent rows for the delegate prompt (non-deterministic — caps were still asserted)",
  );
if (engineKind === "fake") {
  const statuses = subs.map((s) => s.status);
  if (
    subs.length !== 3 ||
    statuses[0] !== "done" ||
    statuses[1] !== "failed" ||
    statuses[2] !== "done"
  )
    fail(
      `subagent arc wrong: ${statuses.join(",")} — expected done,failed,done`,
    );
  for (const s of subs) {
    if (!s.steps.length) fail(`subagent ${s.subagentId} has no steps`);
    if (s.status !== "failed" && !s.result?.trim())
      fail(`subagent ${s.subagentId} finished without a report`);
    if (s.durationMs === undefined)
      fail(`subagent ${s.subagentId} has no durationMs`);
  }
}
await waitFor("the delegate reply", async () =>
  (await employeeReplies(delConv.id, channel.id)).at(-1),
);
out(`delegate turn folded: ${subs.map((s) => s.status).join("/")} helpers`);

// ── 3: employee-helper links to their live session (AC-2) ────────────────
if (engineKind === "fake") {
  /* The engine links a helper to an employee only while that employee has a
     live session — open one for the reviewer first. */
  const { employee: revEmp } = await user.request<{ employee: { id: string } }>(
    "employees.create",
    { name: "Rev 181", role: "reviewer", profile: "reviewer" },
  );
  const { channel: revChannel } = await user.request<{
    channel: { id: string };
  }>("channels.openDm", { employeeId: revEmp.id });
  const revConv = await openTurn("hello", "#181 reviewer", revChannel.id);
  await finished(revConv);
  const revEngineRef =
    (await liveConv(revConv)).engineRef ??
    fail("reviewer conversation never got an engineRef");

  const linkConv = await openTurn(
    "@reviewer delegate this",
    "#181 delegate-to-employee",
  );
  const linkRes = await finished(linkConv);
  const linkTurn = sessionModelOf(linkConv.id, linkRes).turns.at(-1);
  const linked =
    linkTurn?.subagents.find((s) => s.employee)?.employee ??
    fail("no subagent carries an employee link");
  if (linked.employeeRef !== "reviewer")
    fail(`employee link points at ${linked.employeeRef}`);
  if (linked.sessionRef !== revEngineRef)
    fail(
      `employee sessionRef ${linked.sessionRef} != reviewer live session ${revEngineRef}`,
    );
  out(`employee-helper row links to ${linked.employeeRef}'s session`);
}

// ── 4: background job → list → stop (AC-3) ───────────────────────────────
const bgConv = await openTurn(
  engineKind === "fake"
    ? "LILOS_BG run a dev server"
    : (process.env.LILOS_LIVE_BG_PROMPT ??
        "Start a dev server and leave it running in the background."),
  "#181 background",
);
const bgRes = await finished(bgConv);
const bgModel = sessionModelOf(bgConv.id, bgRes);
const sessionId = bgModel.sessionId;
const bgEngineRef = (await liveConv(bgConv)).engineRef;
if (bgEngineRef !== sessionId)
  fail(`engineRef ${bgEngineRef} != session ${sessionId}`);
const job = bgModel.jobs.at(-1);
if (engineKind === "fake" && !job) fail("no job on the session model");
if (!job) {
  out("no background job produced — nothing left running to list or stop");
  cleanup();
  console.log(
    `RESULT: PASS (${status.engine?.name}: caps declared${subs.length ? ", subagents streamed" : ""}; no job rows for this engine/prompt — fake leg covers list→stop)`,
  );
  process.exit(0);
}
if (job.status !== "running")
  fail(`job status ${job.status} after turn — expected running`);
const jobEvents = bgRes.events.filter((e) => e.type.startsWith("job."));
if (!jobEvents.some((e) => e.type === "job.started"))
  fail("no job.started in the stream");

const jobsList = async () =>
  user
    .request<{ jobs: Job[] }>("jobs.list", { sessionId })
    .catch((e) => fail(`jobs.list: ${e}`));
const listedRunning = await waitFor("a running job on jobs.list", async () => {
  const { jobs } = await jobsList();
  return jobs.find((j) => j.jobId === job.jobId && j.status === "running");
});
if (engineKind === "fake") {
  if (listedRunning.command !== "bun run dev")
    fail(`job command '${listedRunning.command}'`);
  if (!listedRunning.tail?.includes("vite v7 ready"))
    fail("job.list tail missing the pumped output");
  if (!listedRunning.url?.includes("localhost:4173"))
    fail(`job url '${listedRunning.url}' — expected the dev server URL`);
}
await waitFor("the background reply", async () =>
  (await employeeReplies(bgConv.id, channel.id)).at(-1),
);
out(`job ${job.jobId} running with tail + url on jobs.list`);

const stop = await user
  .request<{ stopped: boolean }>("jobs.stop", {
    sessionId,
    jobId: job.jobId,
  })
  .catch((e) => fail(`jobs.stop: ${e}`));
if (!stop.stopped) fail("jobs.stop reported stopped:false");
const stopped = await waitFor("job.exited stopped", async () => {
  const { jobs } = await jobsList();
  const j = jobs.find((x) => x.jobId === job.jobId);
  return j?.status === "stopped" ? j : undefined;
});
if (engineKind === "fake" && stopped.status !== "stopped")
  fail(`jobs.list reports ${stopped.status} after jobs.stop`);
if (engineKind === "fake" && stopped.exitCode !== 15)
  fail(`stopped job exitCode ${stopped.exitCode} — expected 15 (SIGTERM)`);
const postStop = sessionModelOf(
  bgConv.id,
  (await sessionEvents(bgConv.id)) ??
    fail("session.events failed after jobs.stop"),
);
const postStopJob = postStop.jobs.find((j) => j.jobId === job.jobId);
if (postStopJob?.status !== "stopped")
  fail(`event-side job status ${postStopJob?.status} after jobs.stop`);
out("jobs.stop → job.exited stopped, jobs.list agrees (Stopped by you)");

// ── 5: replay rebuilds helpers + the job with no duplicates (AC-4) ───────
const delReplay = sessionModelOf(
  delConv.id,
  (await sessionEvents(delConv.id)) ??
    fail("session.events failed on the delegate replay"),
);
const replayedSubs = delReplay.turns.at(-1)?.subagents ?? [];
const subIds = new Set(replayedSubs.map((s) => s.subagentId));
if (replayedSubs.length !== subs.length || subIds.size !== replayedSubs.length)
  fail("delegate replay lost or duplicated subagents");
const bgReplay = sessionModelOf(
  bgConv.id,
  (await sessionEvents(bgConv.id)) ??
    fail("session.events failed on the job replay"),
);
const jobIds = bgReplay.jobs.map((j) => j.jobId);
if (jobIds.length !== new Set(jobIds).size)
  fail(`job rows duplicated on replay: ${jobIds.join(",")}`);
if (!bgReplay.jobs.some((j) => j.jobId === job.jobId && j.status === "stopped"))
  fail("replayed job is not stopped");
out("replay restores subagents + the stopped job, one row each");

// ── 6: a cap-less engine → the phone's gate input disappears (AC-5) ──────
/* LILOS_HIDE_CAPS only filters the harness's internal describe — the
   phone's welcome.engineHost.capabilities come from an unfiltered status
   probe, so hideCaps can never remove them there. The honest negative leg
   is a genuinely cap-less engine: LILOS_ENGINE=command launches this same
   fake with --no-cap, and the welcome simply never carries the ids. */
procs.at(-1)?.kill("SIGTERM");
launchHarness({
  LILOS_ENGINE: "command",
  LILOS_ENGINE_COMMAND:
    "bun packages/engine-fake/scripts/serve.ts --port 0 --tick 25 --watch-stdin --no-cap subagents --no-cap background_jobs",
});
const hiddenWelcome = await waitFor("the cap-less welcome", async () => {
  const w = await freshWelcome("lilos-live-181-c").catch(() => undefined);
  const caps = w?.engineHost?.capabilities?.map((c) => c.id) ?? [];
  /* The re-registered describe wins once a welcome carries capabilities
     again but neither gated id — the old describe also has caps, so a
     non-empty list alone can't mark the swap. */
  return caps.length &&
    !caps.includes("subagents") &&
    !caps.includes("background_jobs")
    ? w
    : undefined;
});
const hiddenCaps =
  hiddenWelcome.engineHost?.capabilities?.map((c) => c.id) ?? [];
if (!hiddenCaps.includes("plan"))
  fail(`unexpected welcome (no 'plan' cap either): ${hiddenCaps.join(",")}`);
out("--no-cap engine drops both caps from welcome — pill/sheets would hide");

cleanup();
console.log(
  `RESULT: PASS (${status.engine?.name}: caps declared, delegate 3 helpers done/failed/done, employee link, job list→stop, replay clean, cap-less negative leg)`,
);
process.exit(0);
