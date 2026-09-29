/**
 * Issue #159 live leg: a thread's pull requests over the real wire —
 * `conversations.prs` from a token client travels relay -> harness ->
 * `gh pr list`, where `gh` is the deterministic fake from
 * packages/host/test/fake-gh serving $GH_FAKE_DIR/list-<branch>.json
 * fixtures. The conversation's `cwd` points at a real git repo on a
 * seeded branch so `repoRoot`/`symbolic-ref` run for real.
 *
 * Driven by scripts/live/159.sh. Asserts:
 *   1. several PRs on the session branch come back deduped and ordered
 *      open -> draft -> merged -> closed (AC-1/AC-2),
 *   2. draft flag + checks rollup (pending/passing/failing/none) survive
 *      the wire (AC-2),
 *   3. a workstream conversation's `workspace.branch` is probed too —
 *      its PR joins the list (AC-2 several-per-session),
 *   4. a just-chat thread (no folder) answers `{prs: []}` and a non-repo
 *      folder surfaces as an error — the app's "nothing shown" (AC-4),
 *   5. editing the gh listing (a PR opened mid-view) shows up on the next
 *      conversations.prs call — no snapshot, no cache (AC-5 trigger data).
 *
 * Exits 0 only when every check passes.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayClient } from "@lilos/client-runtime";
import type { ForgePrsResult } from "@lilos/contracts/host";

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const fakeGhDir = join(repoRoot, "packages/host/test/fake-gh");

const out = (line: string) => console.log(`[live-159] ${line}`);
const fail = (line: string): never => {
  console.error(`[live-159] FAIL ${line}`);
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
const work = mkdtempSync(join(tmpdir(), "lilos159-"));
const relayHome = join(work, "relay");
const harnessHome = join(work, "harness");
const ghDir = join(work, "gh-fake");
const ghLog = join(work, "gh.log");
mkdirSync(relayHome);
mkdirSync(harnessHome);
mkdirSync(ghDir);

/* A real repo on branch feat/forge — forge.prs resolves it for real. */
const repo = join(work, "repo");
mkdirSync(repo);
const git = (args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" });
git(["init", "-b", "main"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
writeFileSync(join(repo, "a.txt"), "one\n");
git(["add", "."]);
git(["commit", "-m", "init"]);
git(["checkout", "-b", "feat/forge"]);
git(["checkout", "-b", "ws/extra"]);
git(["checkout", "feat/forge"]);

const pr = (n: number, over: Record<string, unknown> = {}) => ({
  number: n,
  title: `PR ${n}`,
  url: `https://github.com/acme/widgets/pull/${n}`,
  state: "OPEN",
  isDraft: false,
  headRefName: "feat/forge",
  baseRefName: "main",
  createdAt: "2026-09-24T08:00:00Z",
  statusCheckRollup: [],
  ...over,
});
const writeList = (branch: string, prs: unknown[]) =>
  writeFileSync(
    join(ghDir, `list-${branch.replaceAll("/", "__")}.json`),
    JSON.stringify(prs),
  );

/* feat/forge carries four PRs; ws/extra one more (a dup of 95 to prove
   dedupe across branch listings). */
const featList = () => [
  pr(91, { state: "MERGED" }),
  pr(93, {
    state: "CLOSED",
    statusCheckRollup: [
      { __typename: "StatusContext", context: "ci", state: "FAILURE" },
    ],
  }),
  pr(96, {
    isDraft: true,
    statusCheckRollup: [
      { __typename: "CheckRun", name: "ci", status: "IN_PROGRESS" },
    ],
  }),
  pr(95, {
    statusCheckRollup: [
      {
        __typename: "CheckRun",
        name: "ci",
        status: "COMPLETED",
        conclusion: "SUCCESS",
      },
    ],
  }),
];
writeList("feat/forge", featList());
writeList("ws/extra", [
  pr(97, { headRefName: "ws/extra" }),
  pr(95, { headRefName: "feat/forge" }),
]);

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
      .forEach((l) => console.log(`  [${name}] ${l}`)),
  );
  child.stderr?.on("data", (d) =>
    String(d)
      .trimEnd()
      .split("\n")
      .forEach((l) => console.error(`  [${name}!] ${l}`)),
  );
  return child;
};
const cleanup = () => {
  for (const p of procs) p.kill("SIGTERM");
  rmSync(work, { recursive: true, force: true });
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

/* The harness's PATH leads with the fake-gh dir so `gh` resolves to the
   fixture script; GH_FAKE_DIR/GH_FAKE_LOG steer it. */
launch("harness", ["bun", "apps/harness/src/index.ts"], {
  LILOS_RELAY_URL: relayUrl,
  LILOS_RELAY_TOKEN: relayToken,
  LILOS_HARNESS_HOME: harnessHome,
  LILOS_WORKDIR: join(harnessHome, "work"),
  LILOS_FEED_PORT: String(feedPort),
  LILOS_ENGINE: "fake",
  LILOS_REPO_ROOT: repoRoot,
  PATH: `${fakeGhDir}:${process.env.PATH ?? ""}`,
  GH_FAKE_DIR: ghDir,
  GH_FAKE_LOG: ghLog,
});

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-159", version: "0" },
});
await user.connect().catch((e) => fail(`connect: ${e}`));

/* Wait for the harness to register before forwarded calls can succeed. */
const registered = async (): Promise<boolean> => {
  const s = await user
    .request<{ components?: { id: string; state: string }[] }>(
      "system.status",
      {},
    )
    .catch(() => undefined);
  return (
    s?.components?.some((c) => c.id === "engine" && c.state === "ok") === true
  );
};
{
  const deadline = Date.now() + 20_000;
  while (!(await registered())) {
    if (Date.now() > deadline) fail("harness never registered");
    await new Promise((r) => setTimeout(r, 250));
  }
}
out("relay + harness up (gh = fake-gh fixture)");

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: "Ada 159", role: "engineer", profile: "default" },
);
const { channel } = await user.request<{ channel: { id: string } }>(
  "channels.openDm",
  { employeeId: employee.id },
);
const openConv = async (over: Record<string, unknown>) => {
  const r = await user.request<{ conversation: { id: string } }>(
    "conversations.open",
    { channelId: channel.id, text: "open the thread", ...over },
  );
  return r.conversation;
};
const prsOf = (conversationId: string) =>
  user.request<{ prs: ForgePrsResult["prs"] }>("conversations.prs", {
    conversationId,
  });

/* ── AC-1/AC-2: a folder thread's several PRs, ordered ── */
const conv = await openConv({ cwd: repo });
const { prs } = await prsOf(conv.id);
const numbers = prs.map((p) => p.number);
if (numbers.join(",") !== "95,96,91,93")
  fail(`expected [95,96,91,93] open->draft->merged->closed, got ${numbers}`);
const byNum = new Map(prs.map((p) => [p.number, p]));
if (byNum.get(96)?.draft !== true || byNum.get(96)?.state !== "open")
  fail(`#96 should be an open draft, got ${JSON.stringify(byNum.get(96))}`);
if (
  byNum.get(95)?.checks !== "passing" ||
  byNum.get(96)?.checks !== "pending" ||
  byNum.get(93)?.checks !== "failing" ||
  byNum.get(91)?.checks !== "none"
)
  fail(
    `checks rollup wrong: ${JSON.stringify(prs.map((p) => [p.number, p.checks]))}`,
  );
out(
  "AC-1/AC-2 conversations.prs -> 4 PRs ordered open->draft->merged->closed, draft + CI rollup intact",
);

const log = readFileSync(ghLog, "utf8");
if (!log.includes("pr list") || !log.includes("--head feat/forge"))
  fail(`gh pr list --head feat/forge missing from log:\n${log}`);

/* ── AC-2: a workstream's branch joins the probe ── */
const wsConv = await openConv({
  cwd: repo,
  workspace: { mode: "existing", repoPath: repo, branch: "ws/extra" },
});
const wsPrs = (await prsOf(wsConv.id)).prs.map((p) => p.number);
if (wsPrs.join(",") !== "97,95,96,91,93")
  fail(`workstream prs expected [97,95,96,91,93], got ${wsPrs}`);
out("AC-2 workspace.branch probed too — #97 joins; #95 deduped across heads");

/* ── AC-4: just-chat answers empty; non-repo errors (app shows nothing) ── */
const chat = await openConv({});
const chatPrs = await prsOf(chat.id);
if (chatPrs.prs.length !== 0)
  fail(`just-chat expected prs: [], got ${JSON.stringify(chatPrs.prs)}`);
const plainDir = join(work, "plain");
mkdirSync(plainDir);
const nonRepo = await openConv({ cwd: plainDir });
const nonRepoCall = await user
  .request("conversations.prs", { conversationId: nonRepo.id })
  .then(() => "resolved")
  .catch(() => "errored");
if (nonRepoCall !== "errored")
  fail("non-repo cwd should surface an error the app swallows to nothing");
out("AC-4 just-chat -> {prs: []}, non-repo -> error (phone renders nothing)");

/* ── AC-5 data: an edited listing appears on the next call (no snapshot) ── */
writeList("feat/forge", [
  ...featList(),
  pr(99, { title: "Opened mid-view", headRefName: "feat/forge" }),
]);
const again = await prsOf(conv.id);
if (again.prs[0]?.number !== 99)
  fail(
    `expected the new #99 first on re-fetch, got ${again.prs.map((p) => p.number)}`,
  );
out("AC-5 a PR opened mid-view appears on the next conversations.prs");

out("all legs passed");
cleanup();
process.exit(0);
