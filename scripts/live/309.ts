/**
 * Issues #309 + #308 live leg — record the REAL engine→harness frame
 * sequence for an async `delegate_task` and for engine-initiated work
 * that lands after `turn.completed`, while a newer user message arrives.
 *
 *   bun scripts/live/309.ts [--engine hermes] [--seconds N]
 *
 * Spawns the real relay + harness + `hermes serve` (same env as
 * scripts/live/288.ts). The stub provider (scripts/live/openai-stub.ts,
 * STUB_SCRIPT) scripts the parent model to dispatch one async subagent and
 * holds the child's own model call ~18s so the child outlives the parent
 * turn. Between the parent turn's end and the child's completion a second
 * user message goes out, so the capture shows:
 *
 *   (a) #309 — which frames the delegate arc emits and whether a terminal
 *       subagent state ever lands at/around `turn.completed`;
 *   (b) #308 — which turnId the engine-initiated result-delivery leg
 *       stamps (re-opening the settled turn vs. minting a fresh turn.started
 *       with no ref) relative to the newer user message's turn frames.
 *
 * Prints the full timeline, then PASS/FAIL observations. Exit 0 always —
 * this is a capture, not a gate.
 */
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
const seconds = Number(arg("seconds", "75") ?? "75");
const engineKind = arg("engine", process.env.LILOS_ENGINE ?? "hermes");
const textA = arg("texta", "please delegate now") ?? "please delegate now";
const textB =
  arg("textb", "second question please") ?? "second question please";
/* When set, message B goes out this many ms after message A was sent — while
   turn A may still be running (the #308 ordering leg). Default: 3s after
   the first turn.completed. */
const bAfterMs = arg("bafterms") ? Number(arg("bafterms")) : undefined;

const t0 = Date.now();
const out = (line: string) =>
  console.log(`[live-309 +${String(Date.now() - t0).padStart(5)}ms] ${line}`);
const relayHome = mkdtempSync(join(tmpdir(), "lilos309-relay-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos309-harness-"));
const workdir = join(harnessHome, "work");

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
  throw new Error(`timed out waiting for ${path}`);
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
  const deadline = Date.now() + 30_000;
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
  if (!up) throw new Error("harness feed did not come up");
}

/* ------------------------------ recording -------------------------------- */

interface Rec {
  ms: number;
  seq?: number;
  type: string;
  detail: string;
}
const tape: Rec[] = [];
const rec = (type: string, detail: string, seq?: number) =>
  tape.push({ ms: Date.now() - t0, type, detail, ...(seq ? { seq } : {}) });

const engine = new EngineClient({
  url: `ws://127.0.0.1:${feedPort}/ws`,
  connectTimeoutMs: 60_000,
});
engine.onEvent((e) => {
  const p = e.payload as Record<string, unknown>;
  const bits: string[] = [];
  for (const k of [
    "turnId",
    "ref",
    "toolCallId",
    "tool",
    "subagentId",
    "parentToolCallId",
    "status",
    "stopReason",
    "name",
    "stream",
    "state",
  ]) {
    if (p[k] !== undefined) bits.push(`${k}=${JSON.stringify(p[k])}`);
  }
  for (const k of ["output", "result", "text", "task", "delta"]) {
    if (typeof p[k] === "string" && p[k])
      bits.push(`${k}=${JSON.stringify(String(p[k]).slice(0, 120))}`);
  }
  rec(e.type, `sid=${e.sessionId} ${bits.join(" ")}`, e.seq);
});
await engine.connect();
out("feed connected — recording every engine event");

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-309", version: "0" },
});
await user.connect();

/* Tool-call approvals surface as relay asks — answer "once" so delegate /
   terminal calls run without a human. */
const answeredAsks = new Set<string>();
const approvals = setInterval(() => {
  void user
    .request<{ asks: { id: string; state: string }[] }>("asks.list", {})
    .then(({ asks }) => {
      for (const a of asks) {
        if (a.state !== "open" || answeredAsks.has(a.id)) continue;
        answeredAsks.add(a.id);
        rec("ask.auto-approve", `askId=${a.id} outcome=once`);
        void user
          .request("asks.respond", { askId: a.id, outcome: "once" })
          .catch((e) => rec("ask.respond-failed", `${a.id}: ${e}`));
      }
    })
    .catch(() => {});
}, 400);

/* --------------------------------- run ---------------------------------- */

/* Register before the conversation opens so turn.completed can't race past
   the watcher. */
const firstTurnDone = new Promise<string>((resolve) => {
  const off = engine.onEvent((e) => {
    if (e.type === "turn.completed") {
      off();
      resolve((e.payload as { turnId: string }).turnId);
    }
  });
});

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: "Ada", role: "engineer" },
);
const { channel } = await user.request<{
  channel: { id: string; employeeId: string };
}>("channels.openDm", { employeeId: employee.id });
const messages = user.channelMessages(channel.id);

const { conversation } = await user.request<{
  conversation: { id: string };
}>("conversations.open", {
  channelId: channel.id,
  text: textA,
  title: `frame capture ${Date.now().toString(36)}`,
});
rec("user.message", `A=${JSON.stringify(textA)} conv=${conversation.id}`);
out(`conversation ${conversation.id} — message A sent`);

/* Wait for the parent turn to complete, then let the child keep running. */
const engineRef = await (async (): Promise<string> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const r = await user.request<{
      conversations: { id: string; engineRef?: string }[];
    }>("conversations.list", {});
    const c = r.conversations.find((x) => x.id === conversation.id);
    if (c?.engineRef) return c.engineRef;
    await new Promise((r2) => setTimeout(r2, 200));
  }
  throw new Error("no engineRef on the conversation");
})();
out(`session ${engineRef}`);

async function postB() {
  await user.request("messages.post", {
    channelId: channel.id,
    conversationId: conversation.id,
    authorId: "user",
    authorKind: "user",
    text: textB,
  });
  rec("user.message", `B=${JSON.stringify(textB)}`);
}

let tA: string | undefined;
if (bAfterMs !== undefined) {
  /* #308 ordering leg: fire B while turn A is (probably) still running —
     schedule it relative to A's send time, not after A completes. */
  const sentAt = tape.find((r) => r.type === "user.message")?.ms ?? 0;
  const waitMs = sentAt + bAfterMs - (Date.now() - t0);
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  await postB();
} else {
  tA = await firstTurnDone;
  rec("marker", `turn ${tA} completed — child should still be running`);
  await new Promise((r) => setTimeout(r, 3_000));
  await postB();
}

/* Keep recording through the child's completion + the result-delivery leg. */
const endAt = Date.now() + seconds * 1000;
await new Promise((r) => setTimeout(r, Math.max(0, endAt - Date.now())));

clearInterval(approvals);

/* ------------------------------- dump ----------------------------------- */

console.log("\n================ FRAME TIMELINE ================");
for (const r of tape) {
  const seq = r.seq === undefined ? "  --" : String(r.seq).padStart(4);
  console.log(
    `+${String(r.ms).padStart(6)}ms seq=${seq} ${r.type} ${r.detail}`,
  );
}
console.log("================================================\n");

const msgs = messages.get().messages;
console.log("================ RELAY MESSAGES =================");
for (const m of msgs) {
  console.log(
    `  ${m.id} ${m.authorKind} seq=${m.seq} :: ${JSON.stringify(m.text.slice(0, 90))}`,
  );
}
console.log("=================================================\n");

/* Observations the PR write-ups quote. */
const firstCompleted = tape.find((r) => r.type === "turn.completed");
const idxCompletedA = tA
  ? tape.findIndex(
      (r) => r.type === "turn.completed" && r.detail.includes(`turnId="${tA}"`),
    )
  : firstCompleted
    ? tape.indexOf(firstCompleted)
    : -1;
const subComplete = tape.filter((r) => r.type === "subagent.completed");
const subStarted = tape.filter((r) => r.type === "subagent.started");
const starts = tape.filter((r) => r.type === "turn.started");

out(`turns started: ${starts.map((r) => r.detail).join(" | ") || "none"}`);
out(`subagents started: ${subStarted.length}`);
for (const r of subComplete)
  out(
    `subagent.completed ${r.detail} — after turn.completed(${tA})? ${
      tape.indexOf(r) > idxCompletedA ? "YES (outlives the turn)" : "no"
    }`,
  );
const postA = tape.slice(idxCompletedA + 1).filter((r) => r.type !== "marker");
out(
  `frames after turn.completed(${tA}): ${
    postA.map((r) => `${r.type}(${r.detail.slice(0, 60)})`).join(" | ") ||
    "none"
  }`,
);

user.close();
engine.close();
cleanup();
out("RESULT: capture done");
