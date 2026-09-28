/**
 * Issue #123 live leg: editing an employee's persona (soul) and default model
 * through the REAL relay and harness against a real engine
 * (`hermes serve` or `fake`):
 *
 *   bun apps/harness/scripts/persona-demo.ts [--engine fake|hermes]
 *
 * Drives, over the real app protocol — the same calls the Edit dialog makes:
 *   AC-1 leg — agents.describe advertises `detail.updatable` containing the
 *              fields the dialog renders (soul, model)
 *   AC-2 leg — agents.create makes a disposable profile, then
 *              agents.update {soul, description} + agents.update {model}
 *              land and agents.describe reflects them
 *   AC-3 leg — (hermes only) SOUL.md in ~/.hermes/profiles/<slug> really
 *              changed on disk, i.e. the write went through
 *              profiles.configure
 *   AC-5 leg — employees.update mirrors the new default model onto the
 *              employee record (what the harness pins on session.start);
 *              a running session keeps its model — covered by the
 *              engine-fake e2e + conformance scenario
 * Prints PASS/FAIL per leg and exits non-zero on any failure.
 *
 * Engine selection is the same env the harness uses:
 *   LILOS_ENGINE=fake (default) | hermes
 *   HERMES_PROVIDER / HERMES_MODEL for the hermes leg.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
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
const out = (line: string) => console.log(`[demo123] ${line}`);
const fail = (line: string): never => {
  console.error(`[demo123] FAIL ${line}`);
  try {
    console.error(readFileSync(join(harnessHome, "harness.log"), "utf8"));
  } catch {
    /* no log file */
  }
  cleanup();
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
const port = await freePort();
// The packaged app's launchd harness may already hold the feed default
// (4581) — allocate ours.
const feedPort = await freePort();

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
  for (const [stream, tag] of [
    [child.stdout, ""],
    [child.stderr, "!"],
  ] as const) {
    stream?.on("data", (d) => {
      for (const l of String(d).trimEnd().split("\n")) {
        console.error(`  [${name}${tag}] ${l}`);
      }
    });
  }
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
  LILOS_FEED_PORT: String(feedPort),
  LILOS_ENGINE: engineKind,
  LILOS_REPO_ROOT: repoRoot,
});
out(`relay+harness up (engine=${engineKind})`);

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-demo123-user", version: "0" },
});
await user.connect().catch((e) => fail(`connect: ${e}`));

// The harness registers its engine asynchronously — poll system.status (the
// same call the app's status row uses) until capabilities land.
type Status = {
  engine?: {
    capabilities?: { id: string; detail?: { updatable?: unknown } }[];
  };
};
let engineCaps: { id: string; detail?: { updatable?: unknown } }[] = [];
{
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const st = await user.request<Status>("system.status", {});
      if (st.engine?.capabilities?.length) {
        engineCaps = st.engine.capabilities;
        break;
      }
    } catch {
      /* harness not registered yet */
    }
    if (Date.now() > deadline) fail("engine never reported capabilities");
    await new Promise((r) => setTimeout(r, 400));
  }
}

// Create a disposable profile to edit.
const { models, default: dfltModel } = await user.listModels();
const firstModel = dfltModel ?? models[0]?.id;
if (!firstModel) fail("models.list returned no usable model");
const slug = `demo123-${Date.now().toString(36)}`;
const created = await user
  .createAgent({
    name: slug,
    soul: `You are ${slug}. Short answers only.`,
    model: firstModel,
  })
  .catch((e) => fail(`agents.create: ${e}`));
const agentId = created.id;
console.log(`PROFILE_SLUG=${agentId}`);

// AC-1 leg — the engine's `agents` capability advertises what the dialog may
// edit; the app reads the same list via the engine describe capabilities.
const before = await user
  .describeAgent(agentId)
  .catch((e) => fail(`agents.describe: ${e}`));
const agentsCap = engineCaps.find((c) => c.id === "agents");
const updatable = Array.isArray(agentsCap?.detail?.updatable)
  ? agentsCap.detail.updatable.filter((x): x is string => typeof x === "string")
  : [];
check(
  "AC-1",
  updatable.includes("soul") && updatable.includes("model"),
  `agents detail.updatable=${JSON.stringify(updatable)}`,
);

// AC-2 leg — update soul + description, then the default model.
const soul2 = `You are ${slug}. Cite sources first, then answer in one line.`;
const desc2 = "live edit leg";
await user
  .updateAgent({ id: agentId, soul: soul2, description: desc2 })
  .catch((e) => fail(`agents.update soul: ${e}`));
let d2 = await user.describeAgent(agentId);
check(
  "AC-2-soul",
  d2.soul === soul2 && d2.description === desc2,
  `describe reflects soul/description`,
);
// Prefer a different catalog-listed model so the default visibly changes.
// A `providers:` entry with an empty catalog (e.g. the local stub) can't
// pin — Hermes's switch_model validates the pick, so only choose models
// whose provider the engine listed. When the catalog is empty the leg still
// proves the wire path by asserting the engine's refusal surfaces cleanly.
const agentProvider =
  typeof before.detail?.provider === "string"
    ? before.detail.provider
    : undefined;
const inCatalog = models.filter((m) => m.id && m.provider);
const other =
  inCatalog.find((m) => m.id !== firstModel && m.provider === agentProvider) ??
  inCatalog.find((m) => m.id !== firstModel) ??
  inCatalog[0];
if (!other) {
  // No catalog model to switch to — send the ambient default's id anyway;
  // expect either a clean refusal (engine validated and rejected) or a
  // successful same-model pin. Both prove agents.update reaches
  // profiles.configure; only the refusal is possible under a stub provider.
  let refused = "";
  try {
    await user.updateAgent({ id: agentId, model: firstModel });
  } catch (e) {
    refused = e instanceof Error ? e.message : String(e);
  }
  d2 = await user.describeAgent(agentId);
  check(
    "AC-2-model",
    refused.length > 0 || d2.model === firstModel,
    `catalog empty (provider ${agentProvider ?? "ambient"}) — update ` +
      (refused ? `refused cleanly: ${refused.slice(0, 90)}` : "pinned"),
  );
} else {
  let upd = await user
    .updateAgent({
      id: agentId,
      model: other.id,
      ...(other.provider ? { provider: other.provider } : {}),
    })
    .catch((e) => fail(`agents.update model: ${e}`));
  // A guarded model asks once; the dialog's "Pin anyway" sends confirmModel.
  if (upd.confirmModel) {
    upd = await user
      .updateAgent({
        id: agentId,
        model: other.id,
        ...(other.provider ? { provider: other.provider } : {}),
        confirmModel: true,
      })
      .catch((e) => fail(`agents.update model (confirm): ${e}`));
  }
  d2 = await user.describeAgent(agentId);
  check(
    "AC-2-model",
    d2.model === other.id,
    `default model ${before.model ?? "?"} -> ${d2.model ?? "?"} (${other.provider ?? "ambient"})`,
  );
}

// AC-3 leg — the write landed on disk, not just in the wire reply.
const soulPath = join(homedir(), ".hermes", "profiles", agentId, "SOUL.md");
const soulOnDisk =
  engineKind === "hermes" && existsSync(soulPath)
    ? readFileSync(soulPath, "utf8")
    : null;
check(
  "AC-3",
  engineKind !== "hermes" || soulOnDisk === soul2,
  engineKind === "hermes"
    ? `${soulPath} ${soulOnDisk === soul2 ? "matches" : "differs"}`
    : "n/a on non-hermes engine",
);

// AC-5 leg — LilOS mirrors the engine default onto the employee record; the
// harness pins employee.model on session.start, the per-chat picker still
// wins per session (covered by the e2e suite).
const emp = await user.createEmployee({
  name: "Live Persona",
  role: "editor",
  profile: agentId,
});
const mirrored = await user.updateEmployee(emp.id, { model: d2.model });
check(
  "AC-5",
  mirrored.model === d2.model,
  `employee model mirrored to ${mirrored.model ?? "?"}`,
);

const failed = checks.filter((c) => !c.ok);
for (const c of checks)
  console.log(`RESULT ${c.id}: ${c.ok ? "PASS" : "FAIL"} — ${c.note}`);
console.log(
  `SUMMARY: ${checks.length - failed.length}/${checks.length} legs passed (engine=${engineKind})`,
);
cleanup();
process.exit(failed.length === 0 ? 0 : 1);
