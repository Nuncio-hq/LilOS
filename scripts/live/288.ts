/**
 * Issue #288 live leg — a harness restart re-binds the SAME engine session
 * and never re-prompts already-delivered messages.
 *
 *   bun scripts/live/288.ts [--engine hermes] [--seconds N]
 *
 * Spawns the real relay + harness + `hermes serve` (same env as
 * scripts/live/113.ts), then:
 *
 *   1. opens a DM conversation, sends the root message, waits for the
 *      employee answer; records engineRef, deliveredSeq, and the full relay
 *      message set;
 *   2. stops the harness (the adapter + `hermes serve` die with it — the
 *      restart Oscar's update cycle performs), boots a SECOND harness on the
 *      same relay + harness home;
 *   3. asserts on the new harness's feed:
 *        - `events.since(engineRef, 0)` RESOLVES (the adapter resumed the
 *          stored Hermes session under the same engine id — no
 *          SESSION_NOT_FOUND → no session.start);
 *        - the replayed transcript holds exactly ONE `turn.started` — the
 *          turn that already answered (a re-prompt would mint a second);
 *        - `conv.engineRef` and `deliveredSeq` are unchanged;
 *        - the relay message list is unchanged (no orphan answer);
 *        - harness.log carries no `session.setTitle failed` warning;
 *        - the persisted registry `engine-sessions.json` holds the row.
 *
 * Engine: LILOS_ENGINE (default hermes) + HERMES_PROVIDER/HERMES_MODEL, set by
 * scripts/live/288.sh (stub provider when no real model is signed in).
 * Prints PASS/FAIL. Exit 0 only on PASS.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Relative import: scripts/ is not a workspace dir, so @lilos/* does not
// resolve here — the package resolves its own deps internally.
import {
  EngineClient,
  RelayClient,
} from "../../packages/client-runtime/src/index";

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const seconds = Number(arg("seconds", "90") ?? "90");
const engineKind = arg("engine", process.env.LILOS_ENGINE ?? "hermes");

const out = (line: string) => console.log(`[live-288] ${line}`);
const relayHome = mkdtempSync(join(tmpdir(), "lilos288-relay-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos288-harness-"));
const workdir = join(harnessHome, "work");
const fail = (line: string): never => {
  console.error(`[live-288] FAIL ${line}`);
  try {
    console.error(readFileSync(join(harnessHome, "harness.log"), "utf8"));
  } catch {
    /* no log file */
  }
  process.exit(1);
};

const freePort = () =>
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
      .forEach((l) => void console.log(`  [${name}] ${l}`)),
  );
  child.stderr?.on("data", (d) =>
    String(d)
      .trimEnd()
      .split("\n")
      .forEach((l) => void console.error(`  [${name}!] ${l}`)),
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

const waitForFile = async (path: string, ms = 10_000): Promise<string> => {
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

const waitFor = async <T>(
  what: string,
  fn: () => T | undefined | Promise<T | undefined>,
  ms = seconds * 1000,
): Promise<T> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  return fail(`timed out waiting for ${what}`);
};

/* -------------------------------- boot ---------------------------------- */

const relayPort = await freePort();
const feedPort = await freePort();
launch("relay", ["bun", "apps/relay/src/index.ts"], {
  LILOS_RELAY_HOME: relayHome,
  LILOS_RELAY_PORT: String(relayPort),
});
const relayToken = await waitForFile(join(relayHome, "relay-token"));
const relayUrl = `ws://127.0.0.1:${relayPort}/ws`;
out(`relay ws ${relayUrl}`);

const harnessEnv = () => ({
  LILOS_RELAY_URL: relayUrl,
  LILOS_RELAY_TOKEN: relayToken,
  LILOS_HARNESS_HOME: harnessHome,
  LILOS_WORKDIR: workdir,
  LILOS_ENGINE: engineKind,
  LILOS_FEED_PORT: String(feedPort),
  LILOS_REPO_ROOT: repoRoot,
});

const harness1 = launch(
  "harness",
  ["bun", "apps/harness/src/index.ts"],
  harnessEnv(),
);
out(`harness launched (engine=${engineKind})`);

{
  const deadline = Date.now() + 20_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${feedPort}/host`, {
        method: "OPTIONS",
      });
      if (res.status === 204) {
        up = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) fail("harness feed did not come up");
}

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-288", version: "0" },
});
await user.connect().catch((e) => fail(`relay connect: ${e}`));

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: "Ada", role: "engineer" },
);
const { channel } = await user.request<{
  channel: { id: string; employeeId: string };
}>("channels.openDm", { employeeId: employee.id });
out(`dm channel ${channel.id}`);

const convRow = async (id: string) => {
  const r = await user.request<{
    conversations: {
      id: string;
      engineRef?: string;
      deliveredSeq: number;
    }[];
  }>("conversations.list", {});
  return r.conversations.find((c) => c.id === id);
};

/* ------------------------- leg 1: send → answered ------------------------ */

const { conversation } = await user.request<{
  conversation: { id: string };
}>("conversations.open", {
  channelId: channel.id,
  text: "answer exactly: forty two",
  /* Unique per run: the shared ~/.hermes state.db keeps stale rows whose
     titles would collide with a re-used conversation title. */
  title: `restart leg ${Date.now().toString(36)}`,
});
out(`conversation ${conversation.id}`);

const engineRef = await waitFor(
  "session engineRef",
  async () => (await convRow(conversation.id))?.engineRef || undefined,
);
out(`session ${engineRef}`);

const messages = user.channelMessages(channel.id);
const answered = await waitFor("employee answer", () => {
  const s = messages.get();
  return s.messages.some(
    (m) => m.authorKind === "employee" && m.conversationId === conversation.id,
  )
    ? true
    : undefined;
});
void answered;
const rowBefore = await waitFor(
  "deliveredSeq on the answered row",
  async () => {
    const r = await convRow(conversation.id);
    return r && r.deliveredSeq >= 1 ? r : undefined;
  },
);
const snapshot = messages.get().messages.map((m) => `${m.id}:${m.text}`);
out(`answered; deliveredSeq=${rowBefore.deliveredSeq} msgs=${snapshot.length}`);

/* ------------------------- leg 2: restart harness ------------------------ */

harness1.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 1_500));
out("harness stopped — adapter + hermes backend died with it");

launch("harness2", ["bun", "apps/harness/src/index.ts"], harnessEnv());
out("harness restarted on the same relay + harness home");

{
  const deadline = Date.now() + 20_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${feedPort}/host`, {
        method: "OPTIONS",
      });
      if (res.status === 204) {
        up = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) fail("second harness feed did not come up");
}

const engine2 = new EngineClient({
  url: `ws://127.0.0.1:${feedPort}/ws`,
  connectTimeoutMs: 60_000,
});
/* A re-prompted message lands as a live turn on the rebound session — count
   any the new engine emits for our session id. */
const liveTurns: string[] = [];
const liveEvents: string[] = [];
engine2.onEvent((e) => {
  if (e.sessionId !== engineRef) return;
  liveEvents.push(e.type);
  if (e.type === "turn.started") liveTurns.push(e.type);
});
await engine2.connect().catch((e) => fail(`feed2 connect: ${e}`));
out("feed connected on the new harness");

/* The resumed engine session answers events.since under the SAME engine id —
   SESSION_NOT_FOUND here means the adapter lost the binding (the bug). A
   resumed session's adapter-side log starts empty (hermes keeps the
   transcript in its own state.db), so the replay itself carries no turns. */
const replay = (await engine2
  .request<{
    events: { type: string }[];
    snapshot: { state: string };
  }>("events.since", { sessionId: engineRef, after: 0 })
  .catch((e) => fail(`events.since ${engineRef}: ${e}`))) as {
  events: { type: string }[];
  snapshot: { state: string };
};
out(
  `PASS rebind: events.since(${engineRef}) resumed — state ${replay.snapshot.state}`,
);

/* Give the restart's message replay + reattach a real chance to re-prompt —
   the bug fired within ~10s on Oscar's machine. */
await new Promise((r) => setTimeout(r, 8_000));
if (liveTurns.length !== 0)
  fail(
    `engine emitted ${liveTurns.length} live turn.started after restart — the root was re-prompted`,
  );
out("PASS re-prompt: zero turn.started after restart");

const rowAfter = await waitFor(
  "engineRef still bound after restart",
  async () => (await convRow(conversation.id))?.engineRef || undefined,
  30_000,
);
if (rowAfter !== engineRef)
  fail(
    `engineRef moved ${engineRef} -> ${rowAfter} (rebound to a new session)`,
  );
const delivAfter = (await convRow(conversation.id))?.deliveredSeq;
if (delivAfter !== rowBefore.deliveredSeq)
  fail(
    `deliveredSeq moved ${rowBefore.deliveredSeq} -> ${delivAfter} (a second turn landed)`,
  );
out(`PASS identity: engineRef + deliveredSeq=${delivAfter} unchanged`);

/* ---- leg 3: a NEW message post-restart reuses the resumed session ------- */

await user.request("messages.post", {
  channelId: channel.id,
  conversationId: conversation.id,
  authorId: "user",
  authorKind: "user",
  text: "and again: forty two",
});
out("sent a second message — the resumed session must take this turn");

const deadline2 = Date.now() + seconds * 1000;
let gotSecond = false;
while (Date.now() < deadline2 && !gotSecond) {
  const s = messages.get().messages;
  gotSecond =
    s.filter(
      (m) =>
        m.authorKind === "employee" && m.conversationId === conversation.id,
    ).length >= 2;
  if (!gotSecond) await new Promise((r) => setTimeout(r, 250));
}
if (!gotSecond) {
  /* Dump the resumed session's adapter log + snapshot so the failure mode
     (prompt never dispatched vs engine-side stall) is visible. */
  const probe = (await engine2
    .request<{
      events: { type: string }[];
      snapshot: { state: string; turn?: unknown };
    }>("events.since", { sessionId: engineRef, after: 0 })
    .catch((e) => ({ error: String(e) }))) as
    | { events: { type: string }[]; snapshot: { state: string } }
    | { error: string };
  console.error(`[live-288] live feed events: ${JSON.stringify(liveEvents)}`);
  console.error(`[live-288] session probe: ${JSON.stringify(probe)}`);
  fail("timed out waiting for second employee answer");
}
const rowCont = await convRow(conversation.id);
if (rowCont?.engineRef !== engineRef)
  fail(
    `engineRef moved on the follow-up turn ${engineRef} -> ${rowCont?.engineRef}`,
  );
out(`PASS continuation: follow-up answered on the same session ${engineRef}`);

/* The restart must not have added an orphan answer to an already-answered
   turn: exactly the two real answers land (root + follow-up). */
const after = messages.get().messages.map((m) => `${m.id}:${m.text}`);
const employeeAnswers = messages
  .get()
  .messages.filter(
    (m) => m.authorKind === "employee" && m.conversationId === conversation.id,
  ).length;
if (employeeAnswers !== 2)
  fail(
    `relay thread holds ${employeeAnswers} employee answers — expected 2 (an orphan re-answer would be a third)`,
  );
if (snapshot.some((s, i) => after[i] !== s))
  fail("pre-restart thread content changed across the restart");
out(`PASS thread: ${employeeAnswers} answers, no orphan duplicate`);

const registryPath = join(harnessHome, "engine-sessions.json");
if (!existsSync(registryPath)) fail(`no session registry at ${registryPath}`);
const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
  sessions?: Record<string, { ref?: string }>;
};
const row = registry.sessions?.[engineRef];
if (!row?.ref)
  fail(`registry has no row for ${engineRef}: ${JSON.stringify(registry)}`);
out(`PASS registry: ${engineRef} -> stored ${row.ref}`);

const log = readFileSync(join(harnessHome, "harness.log"), "utf8");
if (log.includes("session.setTitle failed"))
  fail("harness.log still carries `session.setTitle failed`");
out("PASS log: no session.setTitle collision");

user.close();
engine2.close();
cleanup();
out(`RESULT: PASS (engine=${engineKind})`);
