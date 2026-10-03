/**
 * Issue #108 live leg — mid-turn "Review comments on the diff" messages ride
 * the composer's steer-vs-queue rule (AC-3).
 *
 *   bash scripts/live/108.sh        (or: bun scripts/live/108.ts)
 *
 * Boots a real relay + real harness (same as scripts/live/134-rewind.ts),
 * seeds a git folder with uncommitted changes, opens a DM conversation, and
 * sends a first prompt that parks on an approval ask. While the turn is
 * parked (still running), it posts the diff-comments message the Workbench
 * "Send to agent" button produces, then watches the engine feed:
 *
 *   - `turn.steered`   → the engine declared `steer`; the message was
 *                        routed through session.steer (expected path).
 *   - a second turn    → no steer capability; the message became the next
 *                        prompt (the queue fallback AC-3 requires).
 *
 * Answers every approval ask and waits for the turns to settle, then prints
 * a PASS/FAIL summary. With LILOS_ENGINE=hermes + HERMES_PROVIDER/MODEL the
 * same flow runs against a real agent (the steer capability is engine-
 * declared, so the observed route is whichever the engine supports).
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Relative import: scripts/ is not a workspace dir, so @lilos/* does not
// resolve here — the package resolves its own deps internally.
import {
  EngineClient,
  RelayClient,
} from "../../packages/client-runtime/src/index";

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const engineKind = process.env.LILOS_ENGINE ?? "fake";
const relayPort = Number(process.env.LILOS_RELAY_PORT ?? "4577");
const feedPort = Number(process.env.LILOS_FEED_PORT ?? "4581");
const seconds = Number(process.env.TIMEOUT_SEC ?? "180");

const out = (line: string) => console.log(`[live-108] ${line}`);
const fail = (why: string): never => {
  console.error(`[live-108] FAIL ${why}`);
  cleanup();
  process.exit(1);
};

const relayHome = mkdtempSync(join(tmpdir(), "lilos108-relay-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos108-harness-"));
/* The conversation's session folder: a git repo with uncommitted edits so
   git.diff returns content (the same shape the Changes tab reads). */
const picked = mkdtempSync(join(tmpdir(), "lilos108-repo-"));
execFileSync("git", ["init", "-b", "trunk"], { cwd: picked });
writeFileSync(join(picked, "a.txt"), "one\n");
execFileSync("git", ["add", "."], { cwd: picked });
execFileSync(
  "git",
  ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
  { cwd: picked },
);
writeFileSync(join(picked, "a.txt"), "one\ntwo\n");
writeFileSync(join(picked, "notes.txt"), "fresh\nlines\nhere\n");

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
  rmSync(picked, { recursive: true, force: true });
};
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

launch("relay", ["bun", "apps/relay/src/index.ts"], {
  LILOS_RELAY_HOME: relayHome,
  LILOS_RELAY_PORT: String(relayPort),
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

const relayToken = await waitForFile(join(relayHome, "relay-token"));
const relayUrl = `ws://127.0.0.1:${relayPort}/ws`;
out(`relay ws ${relayUrl}`);

{
  const deadline = Date.now() + 10_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${relayPort}/health`);
      if (res.ok || res.status === 404) {
        up = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) fail("relay did not come up");
}

const workdir = join(harnessHome, "work");
launch("harness", ["bun", "apps/harness/src/index.ts"], {
  LILOS_RELAY_URL: relayUrl,
  LILOS_RELAY_TOKEN: relayToken,
  LILOS_HARNESS_HOME: harnessHome,
  LILOS_WORKDIR: workdir,
  LILOS_ENGINE: engineKind,
  LILOS_FEED_PORT: String(feedPort),
  LILOS_REPO_ROOT: repoRoot,
});
out(`harness launched (engine=${engineKind})`);

{
  const deadline = Date.now() + 15_000;
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

/* Feed events drive the PASS/FAIL decision: `turn.steered` means the
   mid-turn message was accepted via session.steer; a `turn.started` after
   the first `turn.completed` means it ran as the queued next prompt. */
const engine = new EngineClient({
  url: `ws://127.0.0.1:${feedPort}/ws`,
  connectTimeoutMs: 60_000,
});

const turnsDone: string[] = [];
let turnStarted = 0;
let steeredText: string | null = null;
engine.onEvent((e) => {
  if (e.type === "turn.started") turnStarted += 1;
  if (e.type === "turn.steered") {
    steeredText = (e.payload as { text?: string }).text ?? "";
  }
  if (e.type === "turn.completed") turnsDone.push(e.turnId ?? "");
});
await engine.connect().catch((e) => fail(`feed connect: ${e}`));
out("feed connected");

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-108", version: "0" },
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

const deadline = Date.now() + seconds * 1000;
const waitFor = async <T>(
  what: string,
  fn: () => T | undefined | Promise<T | undefined>,
): Promise<T> => {
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  return fail(`timed out waiting for ${what}`);
};

/* Answer every open approval ask so parked turns can finish. */
const answerAsks = async () => {
  const { asks } = await user
    .request<{ asks: { id: string; state: string }[] }>("asks.list", {})
    .catch(() => ({ asks: [] }));
  for (const a of asks.filter((x) => x.state === "open")) {
    await user
      .request("asks.respond", { askId: a.id, outcome: "once" })
      .catch(() => {});
    out(`answered ask ${a.id} once`);
  }
};

/* A prompt that produces a mutating step → the fake engine opens an
   approval ask and the turn parks running (the steer test window). */
const { conversation } = await user.request<{
  conversation: { id: string; cwd?: string; engineRef?: string };
}>("conversations.open", {
  channelId: channel.id,
  text: "Add a changelog note to the readme",
  title: "diff comments live",
  cwd: picked,
});
out(`conversation ${conversation.id} cwd=${conversation.cwd}`);

/* Wait until the first turn is running (started, not completed). */
await waitFor("turn 1 running", () => (turnStarted >= 1 ? true : undefined));
await waitFor("turn 1 waiting on its ask", () =>
  turnsDone.length === 0 ? true : undefined,
);
out("turn 1 running — posting the diff-comments message mid-turn");

/* The message Workbench "Send to agent" produces: one user message listing
   every comment with path:line + quoted lines. */
const COMMENTS_MSG = [
  "Review comments on the diff:",
  "",
  "a.txt:2",
  "+two",
  "rename this",
  "",
  "notes.txt:1-3",
  "+fresh",
  "+lines",
  "+here",
  "why three lines?",
].join("\n");
await user.request("messages.post", {
  channelId: channel.id,
  conversationId: conversation.id,
  authorId: "user",
  authorKind: "user",
  text: COMMENTS_MSG,
});
out("mid-turn message posted");

/* Answer any approval ask so the turn can finish and the steer/queue
   outcome becomes observable on the feed. */
for (let i = 0; i < 40 && turnsDone.length === 0; i++) {
  await answerAsks();
  await new Promise((r) => setTimeout(r, 500));
}

/* Now the outcome: either a landed steer (capable engine) or a second turn
   (queue fallback). Both satisfy AC-3 — steer when capable else queued. */
let route: "steer" | "queue" | null = null;
{
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    await answerAsks();
    if (steeredText !== null) {
      route = "steer";
      break;
    }
    if (turnStarted >= 2) {
      route = "queue";
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}
if (!route) fail("no steer.landed and no second turn — message not routed");
out(`route: ${route}`);

/* The message text must reach the agent either way. */
if (
  route === "steer" &&
  steeredText !== null &&
  !steeredText.includes("a.txt:2")
)
  fail("steered text missing the comment payload");
if (route === "steer" && steeredText === "")
  fail("steered event carried no text");

/* Let the turns finish before reporting. */
{
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000 && turnsDone.length === 0) {
    await answerAsks();
    await new Promise((r) => setTimeout(r, 500));
  }
}

out(
  `PASS AC-3 mid-turn routing: ${route === "steer" ? "steered into the running turn (steer capability declared)" : "queued as the next prompt (no steer capability)"}`,
);
cleanup();
process.exit(0);
