/**
 * Issue #114 live leg — the Workbench's host calls answer for a real session.
 *
 *   bun scripts/live/114.ts [--engine hermes] [--seconds N]
 *
 * Spawns the real relay + harness (same env as scripts/live/113.ts), opens one
 * DM conversation whose cwd is a real git repo holding one committed file,
 * one modified file and one untracked file, then drives the exact `POST /host`
 * methods the Workbench calls in Focus:
 *
 *   fs.tree   → the picked repo's files (AC-4)
 *   fs.read   → file contents (AC-4)
 *   git.diff  → modified + untracked files vs HEAD, no base (AC-3)
 *   forge.pr  → a plain answer: {pr:null} or a clean error frame (AC-5)
 *   session.started carries the picked cwd (AC-1/AC-6)
 *
 * On a real provider (HERMES_PROVIDER set) the turn then writes hello.txt and
 * the leg waits for git.diff to show it — the live Changes refresh. On the
 * deterministic stub the model can't write files, so that leg only proves the
 * reply round-trips through real `hermes serve`.
 *
 * Engine: LILOS_ENGINE (default hermes) + HERMES_PROVIDER/HERMES_MODEL, set by
 * scripts/live/114.sh. Prints PASS/FAIL. Exit 0 only on PASS.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const isStub = process.env.HERMES_PROVIDER === "lilos-stub";

const out = (line: string) => console.log(`[live-114] ${line}`);
let harnessHome = "";
const fail = (line: string): never => {
  console.error(`[live-114] FAIL ${line}`);
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
const relayHome = mkdtempSync(join(tmpdir(), "lilos114-relay-"));
harnessHome = mkdtempSync(join(tmpdir(), "lilos114-harness-"));
// The folder Oscar would pick: a real git repo with dirty state.
const picked = mkdtempSync(join(tmpdir(), "lilos114-repo-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: picked });
execFileSync("git", ["-C", picked, "config", "user.email", "live@lilos"]);
execFileSync("git", ["-C", picked, "config", "user.name", "lilos live"]);
writeFileSync(join(picked, "a.txt"), "alpha\n");
execFileSync("git", ["-C", picked, "add", "a.txt"]);
execFileSync("git", ["-C", picked, "commit", "-qm", "init"]);
// One tracked modification + one untracked file = the Changes set.
writeFileSync(join(picked, "a.txt"), "alpha\nbeta\n");
writeFileSync(join(picked, "new.txt"), "new file\n");

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
out(`harness launched (engine=${engineKind}, workdir=${workdir})`);

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
const sessionCwds = new Map<string, string>();
engine.onEvent((e) => {
  if (e.type === "session.started") sessionCwds.set(e.sessionId, e.payload.cwd);
});
await engine.connect().catch((e) => fail(`feed connect: ${e}`));
out("feed connected");

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-114", version: "0" },
});
await user.connect().catch((e) => fail(`relay connect: ${e}`));

// POST /host on the feed port — the same endpoint the Workbench calls.
// Returns { ok: true, result } or { ok: false, error } — forge.pr legs need
// the error frame too, so this one doesn't fail on JSON-RPC errors.
const hostCall = async <T>(method: string, params: unknown = {}) => {
  const res = await fetch(`http://127.0.0.1:${feedPort}/host`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${relayToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) fail(`host ${method}: HTTP ${res.status}`);
  const frame = (await res.json()) as {
    result?: T;
    error?: { code?: number; message: string };
  };
  return frame.error
    ? { ok: false as const, error: frame.error }
    : { ok: true as const, result: frame.result as T };
};

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: "Ada", role: "engineer" },
);
const { channel } = await user.request<{
  channel: { id: string; employeeId: string };
}>("channels.openDm", { employeeId: employee.id });
out(`dm channel ${channel.id}`);

const sysNotes: string[] = [];
const replyTexts: string[] = [];
user.channelMessages(channel.id).subscribe((s) => {
  for (const m of s.messages) {
    if (m.authorKind === "system" && !sysNotes.includes(m.text))
      sysNotes.push(m.text);
    if (m.authorKind === "employee" && !replyTexts.includes(m.text))
      replyTexts.push(m.text);
  }
});

// Leg 1: the session binds the picked repo folder (AC-1/AC-6).
const { conversation } = await user.request<{
  conversation: { id: string; cwd?: string; engineRef?: string };
}>("conversations.open", {
  channelId: channel.id,
  text: "say hello",
  title: "workbench session",
  cwd: picked,
});
out(`conversation ${conversation.id} cwd=${conversation.cwd}`);

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

const engineRefOf = async (id: string) => {
  const r = await user
    .request<{ conversations: { id: string; engineRef?: string }[] }>(
      "conversations.list",
      {},
    )
    .catch(() => undefined);
  return r?.conversations.find((c) => c.id === id)?.engineRef || undefined;
};
const engineRef = await waitFor("session engineRef", () =>
  engineRefOf(conversation.id),
);
const cwd = await waitFor("session.started cwd", () =>
  sessionCwds.get(engineRef),
);
if (cwd !== picked) fail(`session.started cwd ${cwd} != picked ${picked}`);
out(`PASS leg1: session.started cwd = ${cwd}`);

// Leg 2: every host method the Workbench calls answers for that folder.
const tree = await hostCall<{ files: string[]; truncated: boolean }>(
  "fs.tree",
  { path: picked },
);
if (!tree.ok) fail(`fs.tree: ${tree.error.message}`);
if (
  !tree.result.files.includes("a.txt") ||
  !tree.result.files.includes("new.txt")
)
  fail(`fs.tree missing files: ${tree.result.files.join(",")}`);
out(`PASS leg2 fs.tree -> ${tree.result.files.length} files`);

const read = await hostCall<{ content: string; path: string }>("fs.read", {
  path: join(picked, "a.txt"),
});
if (!read.ok) fail(`fs.read: ${read.error.message}`);
if (!read.result.content.includes("alpha")) fail("fs.read a.txt: bad content");
out(`PASS leg2 fs.read a.txt`);

const repoCheck = await hostCall<{ isRepo: boolean; root?: string }>(
  "git.isRepo",
  { path: picked },
);
if (!repoCheck.ok) fail(`git.isRepo: ${repoCheck.error.message}`);
if (!repoCheck.result.isRepo) fail("git.isRepo: picked repo not a repo");
out(`PASS leg2 git.isRepo -> ${repoCheck.result.root}`);

const diff = await hostCall<{
  files: { path: string; status: string; add: number; del: number }[];
}>("git.diff", { path: picked });
if (!diff.ok) fail(`git.diff: ${diff.error.message}`);
const modified = diff.result.files.find(
  (f) => f.path === "a.txt" && f.status === "modified",
);
const added = diff.result.files.find(
  (f) => f.path === "new.txt" && f.status === "added",
);
if (!modified || !added)
  fail(
    `git.diff expected a.txt modified + new.txt added: ${JSON.stringify(diff.result.files)}`,
  );
out(
  `PASS leg2 git.diff -> a.txt +${modified.add}/-${modified.del}, new.txt +${added.add} (untracked)`,
);

const pr = await hostCall<{ pr: unknown; branch?: string }>("forge.pr", {
  path: picked,
});
if (pr.ok) {
  out(
    `PASS leg2 forge.pr -> answered (pr=${JSON.stringify(pr.result.pr)}, branch=${pr.result.branch})`,
  );
} else if (pr.error.code === -32104 || pr.error.code === -32103) {
  out(
    `PASS leg2 forge.pr -> plain error ${pr.error.code} (${pr.error.message})`,
  );
} else {
  fail(`forge.pr: unexpected error ${JSON.stringify(pr.error)}`);
}

// Leg 3: the agent's reply round-trips through the real engine path.
const reply = await waitFor("employee reply", () => replyTexts.at(-1));
out(`PASS leg3: reply posted — "${reply.slice(0, 80)}"`);

// Real-provider only: ask the agent to write a file; git.diff must pick it
// up — the Changes-refresh path. The stub can't write files.
if (!isStub) {
  await user.request("conversations.open", {
    channelId: channel.id,
    text: "Create a file called hello.txt containing the word hi",
    title: "write file",
    cwd: picked,
  });
  const wrote = await waitFor("git.diff picks up hello.txt", async () => {
    const d = await hostCall<{
      files: { path: string; status: string }[];
    }>("git.diff", { path: picked });
    if (!d.ok) return undefined;
    return d.result.files.some((f) => f.path === "hello.txt")
      ? true
      : undefined;
  });
  out(`PASS leg4: agent edit visible via git.diff (hello.txt=${wrote})`);
} else {
  out("SKIP leg4: stub engine cannot write files (run with HERMES_PROVIDER)");
}

user.close();
engine.close();
cleanup();
out(`RESULT: PASS (engine=${engineKind})`);
