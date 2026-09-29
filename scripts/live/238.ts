/**
 * Issue #238 live leg — the phone's folder browser: home-scoped browse,
 * "Found on this Mac", Use -> `folders.add` -> session in the picked dir.
 *
 *   bun scripts/live/238.ts [--engine fake|hermes]
 *
 * Boots a real relay + real harness (engine-fake by default), seeds one
 * employee and a demo folder tree under `~/Documents/lilos-live-238` —
 * INSIDE the user's home so the device-scope home boundary allows it —
 * then mints a real `pairing.offer` grant and prints the `lilos://pair`
 * deep link the phone consumes. Runs until Ctrl-C.
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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { RelayClient } from "../../packages/client-runtime/src/index";

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const engineKind = process.env.LILOS_ENGINE ?? "fake";
const relayPort = Number(process.env.LILOS_RELAY_PORT ?? "4583");
const tailscaleIp = process.env.TAILSCALE_IP;
const employeeName = process.env.EMPLOYEE_NAME ?? "Ada";
const fakeTick = process.env.ENGINE_FAKE_TICK ?? "90";

const out = (line: string) => console.log(`[live-238] ${line}`);
const relayHome = mkdtempSync(join(tmpdir(), "lilos238-relay-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos238-harness-"));

/* The demo tree lives under the REAL home — `folders.browse` refuses
   anything outside it, so a tmpdir fixture would be invisible to the
   phone. Two repos (branches the sheet marks) + a plain dir to tap into. */
const demo = join(homedir(), "Documents", "lilos-live-238");
const seedRepo = (dir: string, branch: string) => {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", branch, dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "live@lilos"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "lilos live"]);
  writeFileSync(join(dir, "README.md"), "# live-238 demo repo\n");
  execFileSync("git", ["-C", dir, "add", "README.md"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
};
seedRepo(join(demo, "demo-repo"), "main");
seedRepo(join(demo, "playground"), "feat/browse");
mkdirSync(join(demo, "notes", "deep", "deeper"), { recursive: true });
mkdirSync(join(demo, ".hidden-seeded"), { recursive: true });
out(`demo tree under home: ${demo}`);

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
  /* The demo tree stays — Oscar may have browsed/picked it; delete it by
     hand: rm -rf ~/Documents/lilos-live-238 */
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
out(`harness launched (engine=${engineKind}, workdir=${workdir})`);

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-238", version: "0" },
});
await user.connect().catch((e) => {
  throw new Error(`relay connect: ${e}`);
});

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: employeeName, role: "engineer" },
);
out(`employee ${employeeName} (${employee.id})`);

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
console.log("  Then on the phone (every AC in the issue):");
console.log(`    Home -> ${employeeName} -> the folder chip in the composer`);
console.log('    -> "Other folder on this Mac…" — the sheet lists the');
console.log("    Mac's home (dirs only, hidden skipped, repos with their");
console.log("    branch) and 'Found on this Mac' at the top. Tap into");
console.log("    ~/Documents/lilos-live-238 -> demo-repo -> Use — the pick");
console.log("    lands on the composer, the folder appears in recents on");
console.log("    the phone AND the web picker, and a send there runs the");
console.log("    session in that folder. A path outside home is refused");
console.log("    with an error, never a listing; an unreachable Mac shows");
console.log("    'Can't reach the Mac right now', not an empty list.");
console.log("");
out("running until Ctrl-C");
await new Promise(() => {});
