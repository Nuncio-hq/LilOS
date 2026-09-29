/**
 * Issue #157 live leg — the phone's live thread (streaming turns, reply,
 * steer queued, stop, per-thread model, ⓘ session sheet).
 *
 *   bun scripts/live/157.ts [--engine fake|hermes]
 *
 * Boots a real relay + real harness (engine-fake by default, slowed to a
 * visible tick so streaming reads as streaming), seeds one employee and one
 * recent folder, then mints a real `pairing.offer` grant and prints the
 * `lilos://pair` deep link the phone consumes. Runs until Ctrl-C.
 *
 * On this VM set TAILSCALE_IP=172.16.4.2 (loopback-side stand-in); on
 * Oscar's Mac leave it unset so the real tailscale probe advertises the
 * Mac's tailnet name.
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
import { RelayClient } from "../../packages/client-runtime/src/index";

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const engineKind = process.env.LILOS_ENGINE ?? "fake";
const relayPort = Number(process.env.LILOS_RELAY_PORT ?? "4577");
const tailscaleIp = process.env.TAILSCALE_IP;
const employeeName = process.env.EMPLOYEE_NAME ?? "Ada";
const fakeTick = process.env.ENGINE_FAKE_TICK ?? "90";

const out = (line: string) => console.log(`[live-157] ${line}`);
const relayHome = mkdtempSync(join(tmpdir(), "lilos157-relay-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos157-harness-"));
// A real git repo to offer as the DM's folder pick + recents entry.
const picked = mkdtempSync(join(tmpdir(), "lilos157-repo-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: picked });
execFileSync("git", ["-C", picked, "config", "user.email", "live@lilos"]);
execFileSync("git", ["-C", picked, "config", "user.name", "lilos live"]);
writeFileSync(join(picked, "README.md"), "# live-157 scratch repo\n");
execFileSync("git", ["-C", picked, "add", "README.md"]);
execFileSync("git", ["-C", picked, "commit", "-qm", "init"]);
// An existing workstream so the sheet's "Continue" row has data.
mkdirSync(join(picked, ".lilos"));
writeFileSync(join(picked, ".lilos", ".gitignore"), "*\n");
execFileSync("git", [
  "-C",
  picked,
  "worktree",
  "add",
  "-b",
  "ws/qr-7",
  join(picked, ".lilos", "wt", "qr-7"),
  "main",
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
launch("harness", ["bun", "apps/harness/src/index.ts"], {
  LILOS_RELAY_URL: relayUrl,
  LILOS_RELAY_TOKEN: relayToken,
  LILOS_HARNESS_HOME: harnessHome,
  LILOS_WORKDIR: workdir,
  LILOS_ENGINE: engineKind,
  ENGINE_FAKE_TICK: fakeTick,
});
out(
  `harness launched (engine=${engineKind}, workdir=${workdir}, tick=${fakeTick}ms)`,
);

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-157", version: "0" },
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
console.log(`  Then on the phone (every AC in the issue):`);
console.log(`    Home -> ${employeeName} -> send a prompt like`);
console.log('    "summarize this repo" — the thread opens and the turn');
console.log("    streams live: Thinking..., a step row, then the text lands");
console.log("    word by word and the card ends with a Worked-for footer.");
console.log("    While it runs, type again -> the bubble shows 'Queued · runs");
console.log("    next'; press the stop square -> the card ends 'You stopped");
console.log("    this turn'. The model chip opens the picker scoped to the");
console.log("    thread (it stays on the pick after the ack), and the title's");
console.log(
  "    ⓘ opens the Session sheet (folder, branch, model, usage, id).",
);
console.log('    A prompt containing "edit" opens a read-only approval card.');
console.log("");
out("running until Ctrl-C");
await new Promise(() => {});
