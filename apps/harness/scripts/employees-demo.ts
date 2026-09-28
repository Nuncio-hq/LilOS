/**
 * Issue #29 live leg: the employee lifecycle through the REAL relay and
 * harness against a real engine (`hermes serve` or `fake`):
 *
 *   bun apps/harness/scripts/employees-demo.ts [--engine fake|hermes] [--seconds N]
 *
 * Drives, over the real app protocol:
 *   AC-1 leg — agents.list returns the engine's real profiles
 *   AC-2 leg — agents.create makes a real profile, then employees.create
 *              links an employee to it (hire new) and to an existing one
 *   AC-3 leg — employees.update edits name + role
 *   AC-4 leg — employees.remove deletes the LilOS record while agents.list
 *              still returns the profile afterwards
 * Prints PASS/FAIL per leg and exits non-zero on any failure.
 *
 * Engine selection is the same env the harness uses:
 *   LILOS_ENGINE=fake (default) | hermes | url + LILOS_ENGINE_URL
 *   HERMES_PROVIDER / HERMES_MODEL for the hermes leg.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayClient } from "@lilos/client-runtime";

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const engineKind = arg("engine", process.env.LILOS_ENGINE ?? "fake") ?? "fake";

const checks: { id: string; ok: boolean; note: string }[] = [];
const check = (id: string, ok: boolean, note: string) => {
  checks.push({ id, ok, note });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${id} — ${note}`);
};
const out = (line: string) => console.log(`[demo29] ${line}`);
const fail = (line: string): never => {
  console.error(`[demo29] FAIL ${line}`);
  try {
    console.error(readFileSync(join(harnessHome, "harness.log"), "utf8"));
  } catch {
    /* no log file */
  }
  process.exit(1);
};

const port = await new Promise<number>((resolve, reject) => {
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

const relayHome = mkdtempSync(join(tmpdir(), "lilos-relay-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos-harness-"));
const procs: ChildProcess[] = [];
const launch = (name: string, cmd: string[], env: Record<string, string>) => {
  const child = spawn(cmd[0] ?? "bun", cmd.slice(1), {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(child);
  child.stderr?.on("data", (d) => {
    for (const l of String(d).trimEnd().split("\n")) {
      console.error(`  [${name}!] ${l}`);
    }
  });
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
  LILOS_RELAY_PORT: String(port),
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
const relayUrl = `ws://127.0.0.1:${port}/ws`;
{
  const deadline = Date.now() + 10_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
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
launch("harness", ["bun", "apps/harness/src/index.ts"], {
  LILOS_RELAY_URL: relayUrl,
  LILOS_RELAY_TOKEN: relayToken,
  LILOS_HARNESS_HOME: harnessHome,
  LILOS_WORKDIR: join(harnessHome, "work"),
  LILOS_ENGINE: engineKind,
  LILOS_REPO_ROOT: repoRoot,
});
out(`relay+harness up (engine=${engineKind})`);

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-demo29-user", version: "0" },
});
await user.connect().catch((e) => fail(`connect: ${e}`));

// AC-1 leg — the engine's real profiles are reachable through the relay.
// The engine may still be booting (`hermes serve` spawn); retry briefly.
let agents: Awaited<ReturnType<typeof user.listAgents>> = [];
{
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      agents = await user.listAgents();
      break;
    } catch (e) {
      if (Date.now() > deadline) fail(`agents.list never answered: ${e}`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}
check("AC-1", true, `agents.list -> ${agents.length} engine profile(s)`);

// AC-2 leg — create a real engine profile, then hire it and an existing one.
const { models, default: dfltModel } = await user.listModels();
const model = dfltModel ?? models[0]?.id;
if (!model) fail("models.list returned no usable model");
const slug = `demo-${Date.now().toString(36)}`;
const created = await user
  .createAgent({
    name: slug,
    soul: `You are ${slug}. Cited answers first.`,
    model,
  })
  .catch((e) => fail(`agents.create: ${e}`));
check(
  "AC-2-create",
  created.id === slug,
  `agents.create -> ${created.id} (model ${created.model ?? "?"})`,
);
const hiredNew = await user.createEmployee({
  name: "Live Auditor",
  role: "compliance",
  profile: created.id,
});
check(
  "AC-2-hire",
  hiredNew.profile === created.id,
  `employee ${hiredNew.id} bound to new profile ${created.id}`,
);
// #115: the hire flow then opens the employee's DM channel.
const dm = await user.request<{ channel: { id: string; employeeId?: string } }>(
  "channels.openDm",
  { employeeId: hiredNew.id },
);
check(
  "AC-2-dm",
  !!dm.channel?.id && dm.channel.employeeId === hiredNew.id,
  `channels.openDm -> ${dm.channel?.id}`,
);
// #115: an engine rejection (duplicate profile name) surfaces plainly and
// nothing else was created.
let rejection = "";
try {
  await user.createAgent({ name: slug });
} catch (e) {
  rejection = e instanceof Error ? e.message : String(e);
}
check(
  "AC-3-reject",
  /already exists/.test(rejection),
  `duplicate agents.create rejected: ${rejection || "(accepted!)"}`,
);
// #115 review: a display-style (mixed-case) name must still land — Hermes
// lowercases profile names, so the adapter resolves the canonical id for the
// post-create describe; and a name differing only in case is still a duplicate.
const mixedRaw = `DemoCase-${slug.slice(5)}`;
const mixed = await user
  .createAgent({ name: mixedRaw, model })
  .catch((e) => fail(`agents.create (mixed case): ${e}`));
check(
  "AC-3-case",
  mixed.id === mixedRaw.toLowerCase(),
  `agents.create("${mixedRaw}") -> canonical ${mixed.id}`,
);
let caseDup = "";
try {
  await user.createAgent({ name: mixedRaw.toUpperCase(), model });
} catch (e) {
  caseDup = e instanceof Error ? e.message : String(e);
}
check(
  "AC-3-case-dup",
  /already exists/.test(caseDup),
  `case-only duplicate rejected: ${caseDup || "(accepted!)"}`,
);
// Printed for scripts/live/115.sh so it can cross-check `hermes profile list`.
console.log(`PROFILE_SLUG=${slug}`);
console.log(`PROFILE_CASE=${mixed.id}`);
let hiredExisting = "skip (no pre-existing profile)";
let empB = hiredNew;
if (agents.length > 0) {
  const first = agents[0];
  if (!first) fail("agents.list returned an empty slot");
  empB = await user.createEmployee({
    name: "Live Hire",
    role: "engineer",
    profile: first.id,
  });
  hiredExisting = `ok — employee ${empB.id} bound to ${first.id}`;
}
check("AC-1-hire", true, hiredExisting);

// AC-3 leg — edit display name + role.
const edited = await user.updateEmployee(hiredNew.id, {
  name: "Live Auditor II",
  role: "audit lead",
});
check(
  "AC-3",
  edited.name === "Live Auditor II" && edited.role === "audit lead",
  `employees.update -> ${edited.name} / ${edited.role}`,
);

// AC-4 leg — remove deletes the LilOS record; the engine profile stays.
await user.removeEmployee(hiredNew.id);
const remaining = await user.request<{ employees: { id: string }[] }>(
  "employees.list",
  {},
);
const after = await user.listAgents();
const recordGone = !remaining.employees.some((e) => e.id === hiredNew.id);
const profileLives = after.some((a) => a.id === created.id);
const { channels } = await user.request<{
  channels: { id: string; kind: string }[];
}>("channels.list", {});
const dmGone = !channels.some((c) => c.id === dm.channel?.id);
check(
  "AC-4",
  recordGone && profileLives && dmGone,
  `removed record=${recordGone}; dm channel gone=${dmGone}; profile ${created.id} still on engine=${profileLives}`,
);

const failed = checks.filter((c) => !c.ok);
for (const c of checks)
  console.log(`RESULT ${c.id}: ${c.ok ? "PASS" : "FAIL"} — ${c.note}`);
console.log(
  `SUMMARY: ${checks.length - failed.length}/${checks.length} legs passed (engine=${engineKind})`,
);
cleanup();
process.exit(failed.length === 0 ? 0 : 1);
