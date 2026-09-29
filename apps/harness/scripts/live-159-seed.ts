/**
 * Issue #159 simulator world — keeps a seeded relay + harness alive so the
 * phone app shows real PR badges.
 *
 *   bun apps/harness/scripts/live-159-seed.ts
 *
 * Boots a real relay (port 4577, or $LILOS_RELAY_PORT) + real harness on
 * engine-fake with `gh` swapped for packages/host/test/fake-gh serving
 * $GH_FAKE_DIR/list-<branch>.json fixtures. Seeds one employee + DM with
 * four threads:
 *   - "Ship the badge fix" — cwd = a real repo on feat/forge whose gh
 *     listing carries four PRs (open passing, draft pending, merged,
 *     closed failing),
 *   - "Draft the RFC" — same repo + workspace branch ws/extra (one more
 *     PR; the feat/forge list dedupes in),
 *   - "Just chat" — no folder → no badges (AC-4),
 *   - "Notes on the docs" — cwd = a plain non-repo dir → nothing (AC-4).
 * Prints the pairing deep link; holds until Ctrl-C.
 *
 * Mid-run edits: rewrite $GH_FAKE_DIR/list-feat__forge.json to change what
 * the seeded threads show on the next refresh (open / turn.completed).
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayClient } from "../../../packages/client-runtime/src/index";

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const fakeGhDir = join(repoRoot, "packages/host/test/fake-gh");
const relayPort = Number(process.env.LILOS_RELAY_PORT ?? "4577");
const tailscaleIp = process.env.TAILSCALE_IP;
const employeeName = process.env.EMPLOYEE_NAME ?? "Ada";

const out = (line: string) => console.log(`[live-159] ${line}`);

const work = mkdtempSync(join(tmpdir(), "lilos159-"));
const relayHome = join(work, "relay");
const harnessHome = join(work, "harness");
const ghDir = join(work, "gh-fake");
mkdirSync(relayHome);
mkdirSync(harnessHome);
mkdirSync(ghDir);
writeFileSync(join(work, "GH_FAKE_DIR"), `${ghDir}\n`);

/* The thread repo: a real git repo on feat/forge with a ws/extra branch —
   forge.prs resolves repoRoot + HEAD for real; only `gh` is faked. */
const repo = join(work, "repo");
mkdirSync(repo);
const git = (args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" });
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "live@lilos"]);
git(["config", "user.name", "lilos live"]);
writeFileSync(join(repo, "README.md"), "# live-159 scratch repo\n");
git(["add", "."]);
git(["commit", "-qm", "init"]);
git(["checkout", "-qb", "feat/forge"]);
git(["checkout", "-qb", "ws/extra"]);
git(["checkout", "-q", "feat/forge"]);

const pr = (n: number, title: string, over: Record<string, unknown> = {}) => ({
  number: n,
  title,
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
writeList("feat/forge", [
  pr(91, "Wire the PR tab", { state: "MERGED" }),
  pr(93, "Drop the old forge view", {
    state: "CLOSED",
    statusCheckRollup: [
      { __typename: "StatusContext", context: "ci", state: "FAILURE" },
    ],
  }),
  pr(96, "Badge polish", {
    isDraft: true,
    statusCheckRollup: [
      { __typename: "CheckRun", name: "ci", status: "IN_PROGRESS" },
    ],
  }),
  pr(95, "Forge list endpoint", {
    statusCheckRollup: [
      {
        __typename: "CheckRun",
        name: "ci",
        status: "COMPLETED",
        conclusion: "SUCCESS",
      },
    ],
  }),
]);
writeList("ws/extra", [
  pr(97, "Workstream preview", { headRefName: "ws/extra" }),
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
      .forEach((l) => {
        console.log(`  [${name}] ${l}`);
      }),
  );
  child.stderr?.on("data", (d) =>
    String(d)
      .trimEnd()
      .split("\n")
      .forEach((l) => {
        console.error(`  [${name}!] ${l}`);
      }),
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
  ...(tailscaleIp ? { LILOS_RELAY_TAILSCALE_IP: tailscaleIp } : {}),
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
const relayToken = await waitForFile(join(relayHome, "relay-token"));
const relayUrl = `ws://127.0.0.1:${relayPort}/ws`;
out(`relay ws ${relayUrl}`);

{
  const deadline = Date.now() + 10_000;
  let up = false;
  while (Date.now() < deadline) {
    const ok = await fetch(`http://127.0.0.1:${relayPort}/`, {
      signal: AbortSignal.timeout(1_000),
    })
      .then(() => true)
      .catch(() => false);
    if (ok) {
      up = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) throw new Error("relay did not come up");
}

launch("harness", ["bun", "apps/harness/src/index.ts"], {
  LILOS_RELAY_URL: relayUrl,
  LILOS_RELAY_TOKEN: relayToken,
  LILOS_HARNESS_HOME: harnessHome,
  LILOS_WORKDIR: join(harnessHome, "work"),
  LILOS_ENGINE: "fake",
  LILOS_REPO_ROOT: repoRoot,
  PATH: `${fakeGhDir}:${process.env.PATH ?? ""}`,
  GH_FAKE_DIR: ghDir,
  GH_FAKE_LOG: join(work, "gh.log"),
});

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-159", version: "0" },
});
await user.connect();

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: employeeName, role: "engineer" },
);
const { channel } = await user.request<{ channel: { id: string } }>(
  "channels.openDm",
  { employeeId: employee.id },
);
const open = async (text: string, over: Record<string, unknown> = {}) =>
  (
    await user.request<{ conversation: { id: string } }>("conversations.open", {
      channelId: channel.id,
      text,
      ...over,
    })
  ).conversation;

await open("Ship the badge fix", { cwd: repo });
await open("Draft the RFC", {
  cwd: repo,
  workspace: { mode: "existing", repoPath: repo, branch: "ws/extra" },
});
await open("Just chat");
const plain = join(work, "plain");
mkdirSync(plain);
await open("Notes on the docs", { cwd: plain });
out("4 threads seeded: repo (4 PRs), workstream (+#97), just-chat, non-repo");

const { offer } = await user.request<{
  offer: { host: string; code: string; name: string; expiresAt: number };
}>("pairing.offer", {});
const link = `lilos://pair?host=${encodeURIComponent(offer.host)}&name=${encodeURIComponent(offer.name)}#code=${offer.code}`;
out(`pairing offer host=${offer.host} name=${offer.name}`);
console.log("");
console.log("  Deep link (valid ~5 min):");
console.log(`    ${link}`);
console.log("");
console.log("  Simulator:");
console.log(`    xcrun simctl openurl booted '${link.replace(/'/g, "'\\''")}'`);
console.log("");
console.log(`  gh fixtures (edit to change badges): ${ghDir}`);
console.log("");
out("running until Ctrl-C");
await new Promise(() => {});
