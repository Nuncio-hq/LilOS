/**
 * Issue #107 live leg — the Workbench's ship buttons (commit, push, create
 * branch, create PR) answer for a real session through the real plumbing.
 *
 *   bun scripts/live/107.ts [--engine hermes] [--seconds N]
 *
 * Spawns the real relay + harness (same env as scripts/live/114.ts), opens
 * one DM conversation whose cwd is a real git repo with a bare `origin`
 * remote, then drives the exact `POST /host` methods the Changes bar calls:
 *
 *   git.status       → the dirty file set the checkboxes render (probe)
 *   git.createBranch → the default-branch "new branch" ask (AC-4)
 *   git.commit       → files staged + committed, clean tree after (AC-1)
 *   git.push         → first push sets upstream; branch lands on origin (AC-3)
 *   forge.create     → `gh pr create` round-trip — the PR URL comes back and
 *                      a `forge.pr` re-read sees the open PR (AC-4)
 *   git.push on a repo with NO remote → plain "no-remote" error (AC-3)
 *   forge.create with gh signed out  → plain "auth" error (AC-3)
 *
 * `gh` is the test double packages/host/test/fake-gh/gh (PATH-injected into
 * the harness): `pr create` writes the view.json a later `pr view` re-reads,
 * like real gh. A real-provider run (HERMES_PROVIDER + HERMES_MODEL set,
 * e.g. Oscar's Mac) additionally asks the agent to write a file and proves
 * git.diff picks it up — the Changes refresh path (AC-5).
 *
 * Engine: LILOS_ENGINE (default hermes) + HERMES_PROVIDER/HERMES_MODEL, set by
 * scripts/live/107.sh. Prints PASS/FAIL. Exit 0 only on PASS.
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

const out = (line: string) => console.log(`[live-107] ${line}`);
let harnessHome = "";
const fail = (line: string): never => {
  console.error(`[live-107] FAIL ${line}`);
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
const relayHome = mkdtempSync(join(tmpdir(), "lilos107-relay-"));
harnessHome = mkdtempSync(join(tmpdir(), "lilos107-harness-"));
const ghFakeDir = mkdtempSync(join(tmpdir(), "lilos107-gh-"));
const ghFakeLog = join(ghFakeDir, "calls.log");
const fakeGhBin = join(repoRoot, "packages/host/test/fake-gh");

// The folder Oscar would pick: a real git repo cloned from a bare origin,
// with one committed file plus a dirty set (one modified, one untracked).
const bare = mkdtempSync(join(tmpdir(), "lilos107-bare-"));
const picked = mkdtempSync(join(tmpdir(), "lilos107-repo-"));
execFileSync("git", ["init", "-q", "--bare", join(bare, "origin.git")]);
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: picked });
execFileSync("git", ["-C", picked, "config", "user.email", "live@lilos"]);
execFileSync("git", ["-C", picked, "config", "user.name", "lilos live"]);
writeFileSync(join(picked, "a.txt"), "alpha\n");
execFileSync("git", ["-C", picked, "add", "a.txt"]);
execFileSync("git", ["-C", picked, "commit", "-qm", "init"]);
execFileSync("git", [
  "-C",
  picked,
  "remote",
  "add",
  "origin",
  join(bare, "origin.git"),
]);
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
  rmSync(ghFakeDir, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
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
  // The host shells out to `gh` by name: put the deterministic fake first.
  PATH: `${fakeGhBin}:${process.env.PATH}`,
  GH_FAKE_DIR: ghFakeDir,
  GH_FAKE_LOG: ghFakeLog,
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
  client: { name: "lilos-live-107", version: "0" },
});
await user.connect().catch((e) => fail(`relay connect: ${e}`));

// POST /host on the feed port — the same endpoint the Workbench calls.
// Returns { ok: true, result } or { ok: false, error } — error legs need
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
    error?: { code?: number; message: string; data?: { reason?: string } };
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

const replyTexts: string[] = [];
user.channelMessages(channel.id).subscribe((s) => {
  for (const m of s.messages) {
    if (m.authorKind === "employee" && !replyTexts.includes(m.text))
      replyTexts.push(m.text);
  }
});

// Leg 1: the session binds the picked repo folder.
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

type Status = {
  root: string;
  branch: string | null;
  clean: boolean;
  files: { path: string; status: string }[];
};

// Leg 2: the probe the bar reads — repo check, dirty files, current branch.
const repoCheck = await hostCall<{ isRepo: boolean; root?: string }>(
  "git.isRepo",
  { path: picked },
);
if (!repoCheck.ok || !repoCheck.result.isRepo)
  fail(`git.isRepo: ${JSON.stringify(repoCheck)}`);
const st = await hostCall<Status>("git.status", { path: picked });
if (!st.ok) fail(`git.status: ${st.error.message}`);
const paths = st.result.files.map((f) => f.path).sort();
if (st.result.branch !== "main")
  fail(`git.status: expected main, got ${JSON.stringify(st.result)}`);
if (!paths.includes("a.txt") || !paths.includes("new.txt"))
  fail(`git.status missing dirty files: ${paths.join(",")}`);
out(`PASS leg2 git.status -> main, dirty ${paths.join(",")}`);

// Leg 3: the default-branch ask — create a feature branch through the host.
const br = await hostCall<{ branch: string }>("git.createBranch", {
  path: picked,
  name: "live-107",
});
if (!br.ok) fail(`git.createBranch: ${br.error.message}`);
if (br.result.branch !== "live-107")
  fail(`git.createBranch: ${JSON.stringify(br.result)}`);
const stBranch = await hostCall<Status>("git.status", { path: picked });
if (!stBranch.ok || stBranch.result.branch !== "live-107")
  fail(`git.status after createBranch: ${JSON.stringify(stBranch)}`);
out("PASS leg3 git.createBranch -> checked out live-107");

// Leg 4: commit the checked files through the host — the tree goes clean.
const commit = await hostCall<{ sha: string; subject: string }>("git.commit", {
  path: picked,
  files: ["a.txt", "new.txt"],
  message: "live leg: staged widget changes",
});
if (!commit.ok) fail(`git.commit: ${commit.error.message}`);
const stClean = await hostCall<Status>("git.status", { path: picked });
if (!stClean.ok || stClean.result.files.length !== 0)
  fail(`git.status after commit: ${JSON.stringify(stClean.result?.files)}`);
out(`PASS leg4 git.commit -> ${commit.result.sha} (clean tree)`);

// Leg 5: first push sets upstream — the branch lands on the bare origin.
const push = await hostCall<{ branch: string | null; upstream: string | null }>(
  "git.push",
  { path: picked },
);
if (!push.ok) fail(`git.push: ${push.error.message}`);
if (push.result.upstream !== "origin/live-107")
  fail(
    `git.push: expected upstream origin/live-107, got ${JSON.stringify(push.result)}`,
  );
const remoteHeads = execFileSync(
  "git",
  ["ls-remote", "--heads", "origin", "live-107"],
  { cwd: picked, encoding: "utf8" },
).trim();
if (!remoteHeads) fail("git.push ran but origin has no live-107 head");
out(`PASS leg5 git.push -> origin/live-107 (${remoteHeads.slice(0, 7)})`);

// Leg 6: forge.create round-trip — the URL comes back, forge.pr re-reads it.
const created = await hostCall<{ url: string }>("forge.create", {
  path: picked,
  title: "live leg PR",
  body: "opened by scripts/live/107.ts",
  base: "main",
});
if (!created.ok) fail(`forge.create: ${created.error.message}`);
const prNow = await hostCall<{ pr: { url?: string; state?: string } | null }>(
  "forge.pr",
  { path: picked },
);
if (!prNow.ok || prNow.result.pr?.url !== created.result.url)
  fail(`forge.pr after create: ${JSON.stringify(prNow)}`);
if (prNow.result.pr?.state !== "open")
  fail(`forge.pr state: ${JSON.stringify(prNow.result)}`);
out(`PASS leg6 forge.create + forge.pr -> ${created.result.url}`);

// Leg 7: plain errors — push with no remote; forge.create with gh signed out.
const noRemote = mkdtempSync(join(tmpdir(), "lilos107-noremote-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: noRemote });
execFileSync("git", ["-C", noRemote, "config", "user.email", "live@lilos"]);
execFileSync("git", ["-C", noRemote, "config", "user.name", "lilos live"]);
writeFileSync(join(noRemote, "b.txt"), "x\n");
execFileSync("git", ["-C", noRemote, "add", "b.txt"]);
execFileSync("git", ["-C", noRemote, "commit", "-qm", "init"]);
const pushErr = await hostCall("git.push", { path: noRemote });
if (pushErr.ok || pushErr.error.data?.reason !== "no-remote")
  fail(`git.push no-remote leg: ${JSON.stringify(pushErr)}`);
out(`PASS leg7 git.push w/o remote -> reason=no-remote`);

writeFileSync(join(ghFakeDir, "fail"), "auth");
const ghErr = await hostCall("forge.create", {
  path: picked,
  title: "t",
  body: "b",
});
if (ghErr.ok || ghErr.error.data?.reason !== "unauthenticated")
  fail(`forge.create signed-out leg: ${JSON.stringify(ghErr)}`);
out(`PASS leg7 forge.create signed out -> reason=unauthenticated`);

// Leg 8: the agent's reply round-trips through the real engine path.
const reply = await waitFor("employee reply", () => replyTexts.at(-1));
out(`PASS leg8: reply posted — "${reply.slice(0, 80)}"`);

// Real-provider only: the agent writes a file; git.diff must pick it up —
// the Changes-refresh path (AC-5). The stub can't write files.
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
  out(`PASS leg9: agent edit visible via git.diff (hello.txt=${wrote})`);
} else {
  out("SKIP leg9: stub engine cannot write files (run with HERMES_PROVIDER)");
}

user.close();
engine.close();
cleanup();
out(`RESULT: PASS (engine=${engineKind})`);
