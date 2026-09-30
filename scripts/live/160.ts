/**
 * Issue #160 live leg — the phone's model picker on the engine's real
 * models.
 *
 *   bun scripts/live/160.ts
 *
 * Boots a real relay + real harness. The default engine is the
 * 160-engine shim (engine-fake whose models.list reports REAL provider
 * slugs, so the picker shows true models.dev logos and per-provider
 * groups); `LILOS_ENGINE=hermes` runs the real engine on Oscar's Mac
 * instead. Seeds one employee, writes one model into the shared
 * `modelVisibility` hide list (the same KV the Mac's Edit models writes),
 * mints a real pairing grant, and prints the deep link + walkthrough.
 *
 * The seeded repo sits on branch feat/forge and — on the fake engine only —
 * `gh` resolves to the deterministic fixture in
 * packages/host/test/fake-gh serving $GH_FAKE_DIR/list-<branch>.json, so a
 * folder thread's "open a PR" turn renders the real PR card under its
 * reply (#159 surface, reused for this PR's evidence). On hermes the
 * harness keeps the real `gh`.
 *
 * On this VM set TAILSCALE_IP=172.16.4.2; on a Mac leave it unset.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayClient } from "../../packages/client-runtime/src/index";

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const engineKind = process.env.LILOS_ENGINE ?? "command";
const relayPort = Number(process.env.LILOS_RELAY_PORT ?? "4577");
const tailscaleIp = process.env.TAILSCALE_IP;
const employeeName = process.env.EMPLOYEE_NAME ?? "Ada";

const out = (line: string) => console.log(`[live-160] ${line}`);
const relayHome = mkdtempSync(join(tmpdir(), "lilos160-relay-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos160-harness-"));
const picked = mkdtempSync(join(tmpdir(), "lilos160-repo-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: picked });
execFileSync("git", ["-C", picked, "config", "user.email", "live@lilos"]);
execFileSync("git", ["-C", picked, "config", "user.name", "lilos live"]);
writeFileSync(join(picked, "README.md"), "# live-160 scratch repo\n");
execFileSync("git", ["-C", picked, "add", "README.md"]);
execFileSync("git", ["-C", picked, "commit", "-qm", "init"]);
/* feat/forge so `forge.prs` reads a branch name the fake-gh listing serves. */
execFileSync("git", ["-C", picked, "checkout", "-qb", "feat/forge"]);

/* The #159 PR card needs `gh pr list` on the session branch; on the fake
   engine the harness PATH leads with packages/host/test/fake-gh, which
   serves these rows (the scripted "open a PR" turn reports /pull/12). */
const ghDir = mkdtempSync(join(tmpdir(), "lilos160-gh-"));
const ghLog = join(ghDir, "gh.log");
writeFileSync(
  join(ghDir, "list-feat__forge.json"),
  JSON.stringify([
    {
      number: 12,
      title: "LIL-3: scaffold pnpm monorepo",
      url: "https://github.com/acme/widgets/pull/12",
      state: "OPEN",
      isDraft: false,
      headRefName: "feat/forge",
      baseRefName: "main",
      createdAt: "2026-09-24T08:00:00Z",
      statusCheckRollup: [
        {
          __typename: "CheckRun",
          name: "ci",
          status: "COMPLETED",
          conclusion: "SUCCESS",
        },
      ],
    },
  ]),
);

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
out(`relay ws ${relayUrl} (home ${relayHome})`);

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
  if (!up) throw new Error("relay did not come up");
}

const workdir = join(harnessHome, "work");
const fakeGhDir = join(repoRoot, "packages/host/test/fake-gh");
launch("harness", ["bun", "apps/harness/src/index.ts"], {
  LILOS_RELAY_URL: relayUrl,
  LILOS_RELAY_TOKEN: relayToken,
  LILOS_HARNESS_HOME: harnessHome,
  LILOS_WORKDIR: workdir,
  LILOS_ENGINE: engineKind,
  ...(engineKind === "command" && !process.env.LILOS_ENGINE_COMMAND
    ? {
        LILOS_ENGINE_COMMAND: "bun scripts/live/160-engine.ts",
        PATH: `${fakeGhDir}:${process.env.PATH ?? ""}`,
        GH_FAKE_DIR: ghDir,
        GH_FAKE_LOG: ghLog,
      }
    : {}),
});
out(`harness launched (engine=${engineKind})`);

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-160", version: "0" },
});
await user.connect().catch((e) => {
  throw new Error(`relay connect: ${e}`);
});

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: employeeName, role: "engineer" },
);
out(`employee ${employeeName} (${employee.id})`);

await user.request("folders.add", { path: picked });
out(`seeded recents: ${picked}`);

/* One hidden model in the shared list (the Mac's Edit models writes the
   same key) — the phone picker must drop it live (AC-1). Shim provider
   slug on the key matches the demo catalog above. */
if (engineKind === "command") {
  await user.request("settings.set", {
    key: "modelVisibility",
    value: { providers: [], models: ["google::fake/opus-2"] },
  });
  out("hid google::fake/opus-2 via settings.set (AC-1)");
}

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
console.log(`  Then on the phone:`);
console.log(`    Home -> ${employeeName} -> DM -> tap the model chip:`);
console.log("    the sheet lists the engine's models grouped by provider with");
console.log("    real logos (Anthropic/OpenAI) and Acme's generic chip; Google's");
console.log(
  "    Fake Opus 2 is hidden by the shared list (AC-1/AC-3). The reasoning",
);
console.log("    slider carries");
console.log(
  "    exactly the picked model's levels and Fast only when it has one",
);
console.log(
  "    (AC-2/AC-3). Pick a model, send, and the chip shows the new pick;",
);
console.log(
  "    inside the thread the same pick is per-thread (AC-4). For the PR",
);
console.log(
  '    card: Home -> the folder row -> open -> send "open a PR" — the',
);
console.log(
  "    reply carries the PR card (fake-gh fixture, fake engine only). To",
);
console.log("    un-hide live, run in another terminal:");
console.log(
  `      bun -e 'import{RelayClient}from"./packages/client-runtime/src/index.ts";const c=new RelayClient({url:"${relayUrl}",token:"${relayToken}"});await c.connect();await c.request("settings.set",{key:"modelVisibility",value:{providers:[],models:[]}})'`,
);
console.log("");
out("running until Ctrl-C");
await new Promise(() => {});
