/**
 * Issue #134 live leg — rewind a session to before a turn: files AND the
 * agent's memory, against real `hermes serve` (WS transport).
 *
 *   bun scripts/live/134-rewind.ts [--engine hermes] [--seconds N]
 *
 * Spawns the real relay + harness (same env as scripts/live/113.ts), then
 * drives a scripted user over `@lilos/client-runtime`:
 *
 *   1. conversations.open { cwd } on a scratch git repo, then two
 *      `messages.post` follow-ups — three user turns. Between turns the
 *      script writes marker files + edits + a deletion (the stand-in for
 *      the agent's own file changes — a real model writes them itself, the
 *      harness checkpoint is engine-neutral so the restore is identical).
 *   2. `conversations.rewind` to the second user message → asserts
 *      filesRestored + engineRewound (hermes WS `command.dispatch` /undo N),
 *      the folder is byte-identical to the pre-turn-2 snapshot, and the
 *      dropped tail is marked rewound (hidden from channelMessages, kept
 *      for audit via messages.list includeRewound).
 *   3. A fourth prompt — when STUB_REQUEST_LOG is set (stub provider run)
 *      the stub's request log proves the rewound turns are gone from the
 *      model's context: the texts it saw contain turn 1 but not turns 2/3.
 *
 * Engine: LILOS_ENGINE (default hermes) + HERMES_PROVIDER/HERMES_MODEL, set
 * by scripts/live/134-rewind.sh (stub provider when no real model is
 * signed in). Prints PASS/FAIL. Exit 0 only on PASS.
 */
import { type ChildProcess, execSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const seconds = Number(arg("seconds", "120") ?? "120");
const engineKind = arg("engine", process.env.LILOS_ENGINE ?? "hermes");

const out = (line: string) => console.log(`[live-134] ${line}`);
let harnessHome = "";
const fail = (line: string): never => {
  console.error(`[live-134] FAIL ${line}`);
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

const relayPort = await freePort();
const feedPort = await freePort();
const relayHome = mkdtempSync(join(tmpdir(), "lilos134-relay-"));
harnessHome = mkdtempSync(join(tmpdir(), "lilos134-harness-"));
/* The folder Oscar would pick — a real git repo so we can prove the user's
   own .git is byte-identical after the rewind (AC-1). */
const picked = mkdtempSync(join(tmpdir(), "lilos134-picked-"));
writeFileSync(join(picked, "seed.txt"), "seed stays\n");
writeFileSync(join(picked, "notes.md"), "notes v1\n");
execSync(
  "git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm seed",
  { cwd: picked },
);
const gitDigest = () =>
  `${execSync("git status --porcelain=v1 && git rev-parse HEAD && git stash list", { cwd: picked })}`;
const cleanGit = gitDigest();

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

const engine = new EngineClient({
  url: `ws://127.0.0.1:${feedPort}/ws`,
  connectTimeoutMs: 60_000,
});
/* turn.completed marks the end of each turn — prompts must wait for it so
   the marker writes land strictly between turns (each turn-start checkpoint
   is the rewind target's restore point). */
const doneTurns = new Set<string>();
let turnSeq = 0;
engine.onEvent((e) => {
  if (e.type === "turn.completed") {
    turnSeq += 1;
    doneTurns.add(`t${turnSeq}`);
  }
});
await engine.connect().catch((e) => fail(`feed connect: ${e}`));
out("feed connected");

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-134", version: "0" },
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

const messages = user.channelMessages(channel.id);
let visibleTexts: string[] = [];
messages.subscribe((s) => {
  visibleTexts = s.messages.map((m) => m.text);
});

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

const { conversation } = await user.request<{
  conversation: { id: string; cwd?: string; engineRef?: string };
}>("conversations.open", {
  channelId: channel.id,
  text: "turn one alpha — create file live-turn-1.txt",
  title: "rewind live",
  cwd: picked,
});
out(`conversation ${conversation.id} cwd=${conversation.cwd}`);

const engineRefOf = async (id: string) => {
  const r = await user
    .request<{ conversations: { id: string; engineRef?: string }[] }>(
      "conversations.list",
      {},
    )
    .catch(() => undefined);
  return r?.conversations.find((c) => c.id === id)?.engineRef || undefined;
};
await waitFor("session engineRef", () => engineRefOf(conversation.id));
await waitFor("turn 1 done", () => (doneTurns.has("t1") ? true : undefined));
out("turn 1 done");

/* The stand-in for the agent's turn-1 file write (a real model writes
   live-turn-1.txt itself; either way the checkpoint owns the restore). */
writeFileSync(join(picked, "live-turn-1.txt"), "agent turn 1\n");

const { message: msg2 } = await user.request<{ message: { id: string } }>(
  "messages.post",
  {
    channelId: channel.id,
    conversationId: conversation.id,
    authorId: "user",
    authorKind: "user",
    text: "turn two beta — create file live-turn-2.txt",
  },
);
await waitFor("turn 2 done", () => (doneTurns.has("t2") ? true : undefined));
writeFileSync(join(picked, "live-turn-2.txt"), "agent turn 2\n");
out("turn 2 done");

const { message: msg3 } = await user.request<{ message: { id: string } }>(
  "messages.post",
  {
    channelId: channel.id,
    conversationId: conversation.id,
    authorId: "user",
    authorKind: "user",
    text: "turn three gamma — create file live-turn-3.txt",
  },
);
await waitFor("turn 3 done", () => (doneTurns.has("t3") ? true : undefined));
writeFileSync(join(picked, "live-turn-3.txt"), "agent turn 3\n");
writeFileSync(join(picked, "notes.md"), "notes v2 EDITED\n");
rmSync(join(picked, "seed.txt"));
out("turn 3 done — rewinding to before turn 2");

const rewind = await user.request<{
  message: { id: string; text: string };
  engineRewound: boolean;
  filesRestored: boolean;
  removedCount: number;
}>("conversations.rewind", {
  conversationId: conversation.id,
  messageId: msg2.id,
});

if (!rewind.filesRestored) fail("filesRestored=false");
if (rewind.engineRewound !== true)
  fail(`engineRewound=${rewind.engineRewound} — expected true on WS`);
out(
  `PASS conversations.rewind: ${JSON.stringify({ engineRewound: rewind.engineRewound, filesRestored: rewind.filesRestored, removedCount: rewind.removedCount })}`,
);

/* AC-1: the folder is byte-identical to the pre-turn-2 snapshot — turn 2/3
   writes gone, turn 1's kept, seed.txt back, notes.md reverted; the user's
   git untouched. */
const bad = (f: string) => `post-rewind folder wrong at ${f}`;
if (!existsSync(join(picked, "live-turn-1.txt"))) fail(bad("live-turn-1.txt"));
if (existsSync(join(picked, "live-turn-2.txt"))) fail(bad("live-turn-2.txt"));
if (existsSync(join(picked, "live-turn-3.txt"))) fail(bad("live-turn-3.txt"));
if (!existsSync(join(picked, "seed.txt"))) fail(bad("seed.txt"));
if (readFileSync(join(picked, "notes.md"), "utf8") !== "notes v1\n")
  fail(bad("notes.md"));
if (gitDigest() !== cleanGit) fail("user git state changed");
out("PASS files: folder restored to pre-turn-2, user git byte-identical");

/* The dropped tail is marked rewound: hidden from channelMessages, still
   audit-able through messages.list includeRewound. */
const all = await user.request<{
  messages: { id: string; seq: number; rewound?: boolean }[];
}>("messages.list", { conversationId: conversation.id, includeRewound: true });
const rewound = all.messages.filter((m) => m.rewound);
if (rewound.length < 2) fail("no rewound rows");
if (
  !rewind.some((m) => m.id === msg2.id) ||
  !rewind.some((m) => m.id === msg3.id)
)
  fail("rewound rows missing turns 2/3 user messages");
await waitFor("visible tail dropped", () =>
  visibleTexts.includes("turn three gamma — create file live-turn-3.txt")
    ? undefined
    : true,
);
if (visibleTexts.includes("turn two beta — create file live-turn-2.txt"))
  fail("turn 2 text still visible in channelMessages");
out(`PASS thread: ${rewound.length} messages marked rewound, hidden live`);

/* AC-2 live memory: the fourth turn's context must lack the dropped turns.
   Under the stub provider the request log shows exactly what the model saw;
   with a real provider hermes' /undo does the same truncation server-side
   (we can't inspect the prompt, so this check is stub-only). */
await user.request("messages.post", {
  channelId: channel.id,
  conversationId: conversation.id,
  authorId: "user",
  authorKind: "user",
  text: "turn four delta",
});
await waitFor("turn 4 done", () => (doneTurns.has("t4") ? true : undefined));

const reqLog = process.env.STUB_REQUEST_LOG;
if (reqLog && existsSync(reqLog)) {
  const lines = readFileSync(reqLog, "utf8").trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1] ?? "{}") as {
    texts?: string[];
  };
  const seen = (last.texts ?? []).join("\n");
  if (!seen.includes("turn one alpha"))
    fail("post-rewind context missing turn 1 (unexpected)");
  for (const dropped of ["turn two beta", "turn three gamma"])
    if (seen.includes(dropped))
      fail(`post-rewind context still contains "${dropped}"`);
  out("PASS memory: model context after rewind = turn 1 + turn 4 only");
} else {
  out(
    "note: no STUB_REQUEST_LOG — memory truncation asserted via engineRewound=true only",
  );
}

user.close();
engine.close();
cleanup();
out(`RESULT: PASS (engine=${engineKind})`);
