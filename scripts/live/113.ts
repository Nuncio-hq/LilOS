/**
 * Issue #113 live leg — a DM conversation carries its folder to the engine.
 *
 *   bun scripts/live/113.ts [--engine hermes] [--seconds N]
 *
 * Spawns the real relay + harness (same env as apps/harness/scripts/demo.ts),
 * then drives a scripted user over `@lilos/client-runtime`:
 *
 *   1. conversations.open { cwd: <a fresh tmp folder> } + a message
 *   2. on the harness feed, `session.started` must carry that cwd (AC-4)
 *   3. a second conversation opened WITHOUT a folder must start in the
 *      harness default workdir, and the thread must carry the
 *      "No folder: working in …" system note (AC-6)
 *   4. `git.isRepo` + `git.branches` answered via `POST /host` prove the
 *      harness host API the header badge reads from (AC-1/AC-7)
 *
 * Engine: LILOS_ENGINE (default hermes) + HERMES_PROVIDER/HERMES_MODEL, set by
 * scripts/live/113.sh (stub provider when no real model is signed in).
 * Prints PASS/FAIL. Exit 0 only on PASS.
 */
import { type ChildProcess, spawn } from "node:child_process";
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

const out = (line: string) => console.log(`[live-113] ${line}`);
let harnessHome = "";
const fail = (line: string): never => {
  console.error(`[live-113] FAIL ${line}`);
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
const relayHome = mkdtempSync(join(tmpdir(), "lilos113-relay-"));
harnessHome = mkdtempSync(join(tmpdir(), "lilos113-harness-"));
// The folder Oscar would pick: a real dir the agent should run in.
const picked = mkdtempSync(join(tmpdir(), "lilos113-picked-"));
writeFileSync(join(picked, "notes.txt"), "picked by lilos\n");

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
  client: { name: "lilos-live-113", version: "0" },
});
await user.connect().catch((e) => fail(`relay connect: ${e}`));

// POST /host on the feed port — the same endpoint the app's picker calls.
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
    error?: { message: string };
  };
  if (frame.error) fail(`host ${method}: ${frame.error.message}`);
  return frame.result as T;
};

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: "Ada", role: "engineer" },
);
const { channel } = await user.request<{
  channel: { id: string; employeeId: string };
}>("channels.openDm", { employeeId: employee.id });
out(`dm channel ${channel.id}`);

const messages = user.channelMessages(channel.id);
const sysNotes: string[] = [];
messages.subscribe((s) => {
  for (const m of s.messages) {
    if (m.authorKind === "system" && !sysNotes.includes(m.text))
      sysNotes.push(m.text);
  }
});

// Leg 1: open a conversation on the picked folder.
const { conversation } = await user.request<{
  conversation: { id: string; cwd?: string; engineRef?: string };
}>("conversations.open", {
  channelId: channel.id,
  text: "pwd — print the directory you are running in",
  title: "folder session",
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

// engineRef lands when the harness binds the conversation — re-list.
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
out(`session ${engineRef}`);
const cwd1 = await waitFor("session.started cwd", () =>
  engineRef ? sessionCwds.get(engineRef) : undefined,
);
if (cwd1 !== picked) fail(`session.started cwd ${cwd1} != picked ${picked}`);
out(`PASS leg1: session.started cwd = ${cwd1}`);

// AC-1 probe: the host API sees the picked folder through the harness.
const listed = await hostCall<{ path: string; entries: { name: string }[] }>(
  "fs.list",
  { path: picked },
);
if (!listed.entries.some((e) => e.name === "notes.txt"))
  fail(`fs.list ${picked} missing notes.txt`);
out(`PASS host fs.list ${picked} -> ${listed.entries.length} entries`);

// Leg 2: no folder — the session lands in the harness default and says so.
const { conversation: conv2 } = await user.request<{
  conversation: { id: string };
}>("conversations.open", {
  channelId: channel.id,
  text: "hello with no folder",
  title: "no folder",
});
const ref2 = await waitFor("second session engineRef", () =>
  engineRefOf(conv2.id),
);
const cwd2 = await waitFor("session.started cwd (default)", () =>
  sessionCwds.get(ref2),
);
if (cwd2 !== workdir)
  fail(`no-folder cwd ${cwd2} != harness workdir ${workdir}`);
out(`PASS leg2: no-folder session.started cwd = ${cwd2}`);
const note = await waitFor('"No folder" system note', () =>
  sysNotes.find((t) => t.startsWith("No folder: working in ")),
);
out(`PASS leg2: thread note "${note}"`);

user.close();
engine.close();
cleanup();
out(`RESULT: PASS (engine=${engineKind})`);
