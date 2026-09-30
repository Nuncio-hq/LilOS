/**
 * Issue #300 live leg — a legacy conversation whose engineRef (`s1`) has no
 * registry row degrades cleanly instead of throwing 'transcript replay
 * failed: no session s1' into the UI, and the persisted usage keeps the
 * context meter alive.
 *
 *   bun scripts/live/300.ts [--engine hermes] [--seconds N]
 *
 * Spawns the real relay + harness + `hermes serve` (same env as
 * scripts/live/288.ts), then:
 *
 *   1. opens TWO conversations and waits for answers:
 *        - convNew keeps its real engineRef (registry-backed, post-#293);
 *        - convOld gets its engine_ref rewritten to the bare legacy id `s1`
 *          in the relay sqlite — Oscar's exact row shape, no registry row.
 *   2. stops the harness (the adapter + `hermes serve` die with it), boots a
 *      SECOND harness on the same relay + harness home;
 *   3. asserts on the new harness's feed:
 *        - `events.since("s1", 0)` RESOLVES with an empty transcript and a
 *          `closed` snapshot — the fix. Pre-fix this rejected with
 *          SESSION_NOT_FOUND, which the feed turned into
 *          'transcript replay failed: no session s1';
 *        - `conversations.list` still carries convOld.usage — the context
 *          meter survives with zero replayed events;
 *        - convOld's relay messages are intact (the degraded transcript);
 *        - `events.since(engineRefNew, 0)` still resumes — the registry
 *          path is untouched (no #293 regression);
 *   4. posts a follow-up on convOld: the harness rebinds via `session.start`
 *      (the same fallback a gateway-404 dead session takes), the conv gets a
 *      fresh real engineRef, and the turn answers;
 *   5. posts a follow-up on convNew: answered on the SAME resumed engineRef.
 *
 * Engine: LILOS_ENGINE (default hermes) + HERMES_PROVIDER/HERMES_MODEL, set by
 * scripts/live/300.sh (stub provider when no real model is signed in).
 * Prints PASS/FAIL. Exit 0 only on PASS.
 */

import { Database } from "bun:sqlite";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

const out = (line: string) => console.log(`[live-300] ${line}`);
const relayHome = mkdtempSync(join(tmpdir(), "lilos300-relay-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos300-harness-"));
const workdir = join(harnessHome, "work");
const fail = (line: string): never => {
  console.error(`[live-300] FAIL ${line}`);
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

const waitForFeed = async (what: string) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${feedPort}/host`, {
        method: "OPTIONS",
      });
      if (res.status === 204) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  fail(`${what} feed did not come up`);
};
await waitForFeed("harness");

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-300", version: "0" },
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

type ConvRow = {
  id: string;
  engineRef?: string;
  deliveredSeq: number;
  usage?: { input?: number; output?: number; cache?: number };
};
const convRow = async (id: string) => {
  const r = await user.request<{ conversations: ConvRow[] }>(
    "conversations.list",
    {},
  );
  return r.conversations.find((c) => c.id === id);
};

const messages = user.channelMessages(channel.id);
const answeredCount = (convId: string) =>
  messages
    .get()
    .messages.filter(
      (m) => m.authorKind === "employee" && m.conversationId === convId,
    ).length;

const openAndAnswer = async (tag: string) => {
  const { conversation } = await user.request<{
    conversation: { id: string };
  }>("conversations.open", {
    channelId: channel.id,
    text: "answer exactly: forty two",
    /* Unique per run: the shared ~/.hermes state.db keeps stale rows whose
       titles would collide with a re-used conversation title. */
    title: `legacy ${tag} ${Date.now().toString(36)}`,
  });
  const engineRef = await waitFor(
    `engineRef for ${tag}`,
    async () => (await convRow(conversation.id))?.engineRef || undefined,
  );
  await waitFor(`answer for ${tag}`, () =>
    answeredCount(conversation.id) >= 1 ? true : undefined,
  );
  const row = await waitFor(`usage persisted for ${tag}`, async () => {
    const r = await convRow(conversation.id);
    /* The stub's OpenAI-style usage isn't mapped into Hermes' accounting, so
       the live values are zeros — what matters is the object landed on the
       row (non-zero values are pinned by the unit tests). */
    return r?.usage ? r : undefined;
  });
  out(
    `${tag}: conv ${conversation.id} session ${engineRef} usage=${JSON.stringify(row.usage)}`,
  );
  return { conversation, engineRef };
};

/* ------------- leg 1: two answered conversations ------------------------ */

const newConv = await openAndAnswer("new");
const oldConv = await openAndAnswer("old");
const oldSnapshot = messages
  .get()
  .messages.filter((m) => m.conversationId === oldConv.conversation.id)
  .map((m) => `${m.id}:${m.text}`);

/* ------------- leg 2: restart; convOld becomes a legacy `s1` ------------- */

harness1.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 1_500));
out("harness stopped — adapter + hermes backend died with it");

/* Oscar's exact row shape: pre-1.0.28 conversations carry a bare engine id
   with no SessionRegistry row (the registry did not exist yet). Writing the
   ref while the relay is down mirrors how the relay DB outlives the engine. */
{
  const db = new Database(join(relayHome, "relay.sqlite"));
  db.exec(
    `UPDATE conversations SET engine_ref = 's1' WHERE id = '${oldConv.conversation.id}'`,
  );
  db.close();
}
out(`legacy conv ${oldConv.conversation.id}: engine_ref rewritten to s1`);

launch("harness2", ["bun", "apps/harness/src/index.ts"], harnessEnv());
out("harness restarted on the same relay + harness home");
await waitForFeed("harness2");

const engine2 = new EngineClient({
  url: `ws://127.0.0.1:${feedPort}/ws`,
  connectTimeoutMs: 60_000,
});
await engine2.connect().catch((e) => fail(`feed2 connect: ${e}`));
out("feed connected on the new harness");

/* THE fix: pre-#300 this rejected with SESSION_NOT_FOUND, which the feed
   wrapped as 'transcript replay failed: no session s1'. Now the dead ref
   resolves to an empty transcript + closed snapshot — the UI renders the
   relay messages instead of an error string. */
const deadReplay = (await engine2
  .request<{
    events: { type: string }[];
    snapshot: { state: string };
  }>("events.since", { sessionId: "s1", after: 0 })
  .catch((e) => fail(`events.since s1 rejected: ${e} — the bug is back`))) as {
  events: { type: string }[];
  snapshot: { state: string };
};
if (deadReplay.events.length !== 0)
  fail(
    `events.since s1 replayed ${deadReplay.events.length} events — expected an empty degraded transcript`,
  );
if (deadReplay.snapshot.state !== "closed")
  fail(
    `events.since s1 snapshot state ${deadReplay.snapshot.state} — expected closed`,
  );
out(
  "PASS degrade: events.since(s1) resolves empty + closed (no replay-failed)",
);

/* The registry path is untouched: the post-#293 session still resumes. */
const liveReplay = (await engine2
  .request<{
    events: { type: string }[];
    snapshot: { state: string };
  }>("events.since", { sessionId: newConv.engineRef, after: 0 })
  .catch((e) =>
    fail(`events.since ${newConv.engineRef} (registry-backed): ${e}`),
  )) as {
  events: { type: string }[];
  snapshot: { state: string };
};
out(
  `PASS resume: events.since(${newConv.engineRef}) still resolves — state ${liveReplay.snapshot.state}`,
);

/* The meter survives replay failure: the usage persisted by turn.completed
   rides on the conversation row — no engine events needed. */
const oldRow = await waitFor("usage on the legacy row", async () => {
  const r = await convRow(oldConv.conversation.id);
  return r?.usage ? r : undefined;
});
out(`PASS meter: legacy row keeps usage=${JSON.stringify(oldRow.usage)}`);

/* The degraded transcript is the relay's own messages, unchanged. */
const oldNow = messages
  .get()
  .messages.filter((m) => m.conversationId === oldConv.conversation.id)
  .map((m) => `${m.id}:${m.text}`);
if (JSON.stringify(oldNow) !== JSON.stringify(oldSnapshot))
  fail("legacy conv's relay messages changed across the restart");
out(`PASS transcript: ${oldNow.length} relay messages intact`);

/* ------- leg 3: the next send reaches the session.start fallback -------- */

await user.request("messages.post", {
  channelId: channel.id,
  conversationId: oldConv.conversation.id,
  authorId: "user",
  authorKind: "user",
  text: "and again: forty two",
});
out("posted on the legacy conv — must rebind via session.start and answer");

await waitFor("legacy conv follow-up answer", () =>
  answeredCount(oldConv.conversation.id) >= 2 ? true : undefined,
);
const oldRebound = await waitFor(
  "fresh engineRef on the legacy row",
  async () => {
    const r = await convRow(oldConv.conversation.id);
    return r && r.engineRef && r.engineRef !== "s1" ? r : undefined;
  },
  30_000,
);
out(
  `PASS fallback: legacy conv rebound s1 -> ${oldRebound.engineRef}, follow-up answered`,
);

/* And the registry-backed conv still takes its next turn on the same
   resumed session. */
await user.request("messages.post", {
  channelId: channel.id,
  conversationId: newConv.conversation.id,
  authorId: "user",
  authorKind: "user",
  text: "and again: forty two",
});
await waitFor("registry conv follow-up answer", () =>
  answeredCount(newConv.conversation.id) >= 2 ? true : undefined,
);
const newRow = await convRow(newConv.conversation.id);
if (newRow?.engineRef !== newConv.engineRef)
  fail(
    `registry conv engineRef moved ${newConv.engineRef} -> ${newRow?.engineRef}`,
  );
out(
  `PASS resume path: follow-up answered on the same session ${newConv.engineRef}`,
);

const log = readFileSync(join(harnessHome, "harness.log"), "utf8");
if (log.includes("session.setTitle failed"))
  fail("harness.log still carries `session.setTitle failed`");

user.close();
engine2.close();
cleanup();
out(`RESULT: PASS (engine=${engineKind})`);
