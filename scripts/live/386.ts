/**
 * Issue #386 live leg — an employee-helper's row in the phone's Subagents
 * sheet opens that employee's own thread.
 *
 *   bun scripts/live/386.ts
 *
 * Boots a real relay + real harness (seeded the same way as
 * scripts/live/156.ts), seeds the two-employee world the check needs, then
 * mints a real `pairing.offer` grant and prints the `lilos://pair` deep
 * link the phone consumes. Everything runs until Ctrl-C.
 *
 * The engine-fake emits an employee-targeted subagent when a `delegate` /
 * `subagents` prompt @mentions another live employee's profile (the
 * `employee = mention` branch in packages/engine-fake/src/script.ts); its
 * `employeeLink` only resolves when that agent exists AND has a live
 * session, so Blair gets a DM with an opening "hello" first — her session
 * must be live before the delegate turn starts.
 *
 * On this VM set TAILSCALE_IP=172.16.4.2 (the loopback-side stand-in for a
 * tailnet address); on Oscar's Mac leave it unset so the real tailscale
 * probe advertises the Mac's tailnet name.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Relative import: scripts/ is not a workspace dir, so @lilos/* does not
// resolve here — the package resolves its own deps internally.
import { RelayClient } from "../../packages/client-runtime/src/index";

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const engineKind = process.env.LILOS_ENGINE ?? "fake";
const relayPort = Number(process.env.LILOS_RELAY_PORT ?? "4577");
const tailscaleIp = process.env.TAILSCALE_IP;
const employeeName = process.env.EMPLOYEE_NAME ?? "Ada";
const helperName = process.env.HELPER_NAME ?? "Blair";
const helperProfile = process.env.HELPER_PROFILE ?? "reviewer";

const out = (line: string) => console.log(`[live-386] ${line}`);
const relayHome = mkdtempSync(join(tmpdir(), "lilos386-relay-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos386-harness-"));

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
});
out(`harness launched (engine=${engineKind}, workdir=${workdir})`);

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-386", version: "0" },
});
await user.connect().catch((e) => {
  throw new Error(`relay connect: ${e}`);
});

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: employeeName, role: "engineer" },
);
out(`employee ${employeeName} (${employee.id})`);

// The helper-employee: `profile` is the engine-agent handle the @mention
// resolves against, so it must be an agent id the engine knows (reviewer
// is in engine-fake's catalog).
const { employee: helper } = await user.request<{
  employee: { id: string };
}>("employees.create", {
  name: helperName,
  role: "reviewer",
  profile: helperProfile,
});
out(`employee ${helperName} (${helper.id}, profile ${helperProfile})`);

// Wake Blair's session: `employeeLink` needs a live session for the
// mentioned agent, and the phone resolves `sessionRef` to the
// conversation carrying that engineRef — both come from a real DM turn.
const { channel: helperDm } = await user.request<{
  channel: { id: string };
}>("channels.openDm", { employeeId: helper.id });
const { conversation: helperConv } = await user.request<{
  conversation: { id: string };
}>("conversations.open", {
  channelId: helperDm.id,
  text: "hello",
  title: "#386 Blair's own thread",
});
out(`opened ${helperName}'s DM (${helperConv.id})`);

// conversations.open answers a snapshot taken before the harness attaches
// engineRef — poll conversations.list for the live row.
{
  const deadline = Date.now() + 20_000;
  let bound = false;
  while (Date.now() < deadline) {
    const { conversations } = await user.request<{
      conversations: { id: string; engineRef?: string }[];
    }>("conversations.list", {});
    if (conversations.find((c) => c.id === helperConv.id && c.engineRef)) {
      bound = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!bound)
    throw new Error(`${helperName}'s conversation never got an engineRef`);
}
out(`${helperName}'s session is live — @${helperProfile} will link`);

// The real pairing grant — the same call the app's pair flow consumes.
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
console.log("  Then on the phone:");
console.log(`    Home -> ${employeeName} -> DM -> send`);
console.log(
  `    "delegate the summary work to subagents; @${helperProfile} helps"`,
);
console.log(
  '    -> the turn card\'s "3 subagents · Open" link -> the Subagents sheet',
);
console.log(
  `    -> tap the "${helperName} · Draft the summary" row (Finished group)`,
);
console.log(
  `    -> lands on ${helperName}'s own thread ("#386 ${helperName}'s own`,
);
console.log('    thread") — the check issue #386 asks for.');
console.log("");
out("running until Ctrl-C");
await new Promise(() => {});
