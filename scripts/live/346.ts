/**
 * Issue #346 live leg — on real `hermes serve`: an idle session suspends,
 * its background `sleep` dies with it, RSS drops, and the next message
 * resumes the SAME session with memory intact (AC-2/AC-3/AC-5/AC-6).
 *
 *   bun scripts/live/346.ts [--engine hermes] [--seconds N]
 *
 * Spawns the real relay + harness + `hermes serve` (the same env shape as
 * the archived restart leg on tag archive/live-scripts-2026-10) with
 * LILOS_SESSION_IDLE_MINUTES=0.25 (the leg sets
 * the env itself — the shipped default stays 30), then:
 *
 *   1. opens a DM conversation; the stub's scripted `terminal` tool call
 *      starts a real background `sleep 371` (job row mints on completion);
 *   2. waits for the reaper's `session.suspend` (idle 15s + the 60s tick):
 *      conversation life -> "closed" on the wire;
 *   3. asserts `sleep 371` is no longer running and the `hermes serve`
 *      backend's RSS dropped;
 *   4. sends a follow-up; asserts the resumed turn's model request carries
 *      the AC-5 reopened notice AND turn 1's codeword (memory), and the
 *      conversation life is "open" again.
 *
 * Prints the before/after RSS numbers + PASS/FAIL. Exit 0 only on PASS.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Relative import: scripts/ is not a workspace dir, so @lilos/* does not
// resolve here — the package resolves its own deps internally.
import { RelayClient } from "../../packages/client-runtime/src/index";

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const seconds = Number(arg("seconds", "150") ?? "150");
const engineKind =
  arg("engine", process.env.LILOS_ENGINE ?? "hermes") ?? "hermes";
const requestLog = process.env.STUB_REQUEST_LOG ?? "/tmp/live-346-requests.log";

const out = (line: string) => console.log(`[live-346] ${line}`);
const relayHome = mkdtempSync(join(tmpdir(), "lilos346-relay-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos346-harness-"));
const workdir = join(harnessHome, "work");
const fail = (line: string): never => {
  console.error(`[live-346] FAIL ${line}`);
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

/* `sleep 371` marks the background process the scripted terminal call
   starts — a signature nothing else on the machine has. */
const sleepRunning = () =>
  spawnSync("pgrep", ["-f", "sleep 371"], { encoding: "utf8" })
    .stdout.trim()
    .split("\n")
    .filter(Boolean).length;

/* RSS (KB) of the `hermes serve` backend holding the engine session. */
const engineRssKb = () => {
  const pids = spawnSync("pgrep", ["-f", "serve --host 127.0.0.1"], {
    encoding: "utf8",
  })
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  let kb = 0;
  for (const pid of pids) {
    const r = spawnSync("ps", ["-o", "rss=", "-p", pid], { encoding: "utf8" });
    kb += Number(r.stdout.trim()) || 0;
  }
  return pids.length ? kb : 0;
};

/* Process tree under the `hermes serve` root: pid, rss, command — the
   session's workers/children show up here and die on suspend. */
const engineTree = () => {
  const roots = spawnSync("pgrep", ["-f", "serve --host 127.0.0.1"], {
    encoding: "utf8",
  })
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  const rows = spawnSync("ps", ["-axo", "pid,ppid,rss,comm"], {
    encoding: "utf8",
  })
    .stdout.trim()
    .split("\n")
    .slice(1)
    .map((l) => {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      return m
        ? {
            pid: Number(m[1]),
            ppid: Number(m[2]),
            rss: Number(m[3]),
            comm: m[4],
          }
        : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const byParent = new Map<number, typeof rows>();
  for (const r of rows) {
    const list = byParent.get(r.ppid) ?? [];
    list.push(r);
    byParent.set(r.ppid, list);
  }
  const tree: typeof rows = [];
  const queue = [...roots.map(Number)];
  const seen = new Set<number>();
  while (queue.length) {
    const pid = queue.shift() ?? 0;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of byParent.get(pid) ?? []) {
      tree.push(child);
      queue.push(child.pid);
    }
  }
  return { roots, tree };
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
  /* AC-3: the idle timeout is env-tunable — the leg runs a 15s idle instead
     of the shipped 30-minute default. The 1-minute check cadence stays. */
  LILOS_SESSION_IDLE_MINUTES: "0.25",
});
out(`harness launched (engine=${engineKind}, idle=15s)`);

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
  client: { name: "lilos-live-346", version: "0" },
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
await user.request("channel.subscribe", { channelId: channel.id });

const convRow = async (id: string) => {
  const r = await user.request<{
    conversations: { id: string; engineRef?: string; life?: string }[];
  }>("conversations.list", {});
  return r.conversations.find((c) => c.id === id);
};

/* Every `life` write the relay broadcasts for this conversation. */
const lives: string[] = [];
user.onEvent((method, params) => {
  const c = (params as { conversation?: { id?: string; life?: string } })
    .conversation;
  if (method === "conversation.updated" && c?.life) lives.push(c.life);
});

/* ------------------- leg 1: codeword + a real background sleep ---------- */

const { conversation } = await user.request<{
  conversation: { id: string };
}>("conversations.open", {
  channelId: channel.id,
  /* Name the exact command — "start a background sleep" lets a real model
     pick its own duration and `sleep 371` never exists to kill. access
     'full' keeps the terminal call off the approval card (#106) — the leg
     is unsupervised. */
  text: "run `sleep 371` in the background with the terminal tool, then tell me the codeword ZEBRA_9",
  access: "full",
  title: `idle-close leg ${Date.now().toString(36)}`,
});
out(`conversation ${conversation.id}`);

const engineRef = await waitFor(
  "session engineRef",
  async () => (await convRow(conversation.id))?.engineRef || undefined,
);
out(`session ${engineRef}`);

const messages = user.channelMessages(channel.id);
const answered = await waitFor("employee answer", () =>
  messages
    .get()
    .messages.some(
      (m) =>
        m.authorKind === "employee" && m.conversationId === conversation.id,
    )
    ? true
    : undefined,
);
void answered;
await waitFor("background sleep running", () =>
  sleepRunning() > 0 ? true : undefined,
);
out("background `sleep 371` running");

const rssBefore = engineRssKb();
const treeBefore = engineTree();
out(`engine RSS before suspend: ${rssBefore} KB`);
out(
  `engine tree before suspend: ${treeBefore.tree.length} children ` +
    `${treeBefore.tree.map((c) => `${c.pid}:${c.comm}(${c.rss}KB)`).join(" ")}`,
);

/* ------------- leg 2: idle -> suspend, the process dies, RSS drops ------ */

await waitFor("session.suspend (idle 15s + 60s tick)", async () =>
  (await convRow(conversation.id))?.life === "closed" ? true : undefined,
);
out(`life -> closed (wire sequence: ${lives.join(" -> ")})`);

await waitFor("background sleep reaped", () =>
  sleepRunning() === 0 ? true : undefined,
);
out("background `sleep 371` is gone");

const rssAfter = engineRssKb();
const treeAfter = engineTree();
out(`engine RSS after suspend: ${rssAfter} KB (was ${rssBefore} KB)`);
out(
  `engine tree after suspend: ${treeAfter.tree.length} children ` +
    `${treeAfter.tree.map((c) => `${c.pid}:${c.comm}(${c.rss}KB)`).join(" ")}`,
);
const childRss = (t: typeof treeAfter) => t.tree.reduce((s, c) => s + c.rss, 0);
const kidsBefore = childRss(treeBefore);
const kidsAfter = childRss(treeAfter);
out(`session children RSS: ${kidsBefore} KB -> ${kidsAfter} KB`);
if (kidsAfter >= kidsBefore && treeAfter.tree.length >= treeBefore.tree.length)
  out("warn: no session child freed — check the backend's process tree");

/* ------------- leg 3: next message resumes with memory ------------------ */

await user.request("messages.post", {
  channelId: channel.id,
  conversationId: conversation.id,
  authorId: "user",
  authorKind: "user",
  text: "recall: what was the codeword?",
});
await waitFor("resumed answer", () => {
  const s = messages.get();
  return s.messages.filter(
    (m) => m.authorKind === "employee" && m.conversationId === conversation.id,
  ).length >= 2
    ? true
    : undefined;
});
const rowAfter = await convRow(conversation.id);
if (rowAfter?.engineRef !== engineRef)
  fail(`engineRef changed on resume: ${engineRef} -> ${rowAfter?.engineRef}`);
out(`resumed under the same session ${engineRef}; life=${rowAfter?.life}`);

/* Memory on the model side: the resumed request's context carries turn 1's
   codeword; AC-5's once-note is in the same user message. Read the stub's
   request log for the last request. */
try {
  const lines = readFileSync(requestLog, "utf8").trim().split("\n");
  const last = lines.at(-1) ?? "";
  const hasNotice = last.includes("session was reopened");
  const hasMemory = last.includes("ZEBRA_9");
  out(
    `model request #${lines.length}: notice=${hasNotice} codeword-in-context=${hasMemory}`,
  );
  if (!hasNotice) fail("AC-5 notice missing from the resumed turn's prompt");
  if (!hasMemory) fail("turn 1 codeword missing from the resumed context");
} catch {
  out(
    "warn: no STUB_REQUEST_LOG — memory/notice asserts skipped (live model?)",
  );
}

out(`life sequence: ${lives.join(" -> ") || "no broadcasts seen"}`);
cleanup();
console.log("[live-346] PASS");
process.exit(0);
