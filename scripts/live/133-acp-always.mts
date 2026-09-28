#!/usr/bin/env bun
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Harness,
  SUITES,
} from "../../packages/engine-conformance/src/index.js";
import {
  connectInMemory,
  HermesEngine,
  HermesGateway,
  startHermesServe,
} from "../../packages/engine-hermes/src/index.js";

/**
 * Issue #133 live check — "Always allow" must be permanent on the ACP
 * transport.
 *
 * Hermes' acp_adapter offers two options with kind `allow_always`
 * (`allow_session` first, then `allow_always`). The engine-conformance
 * `mcp_servers` scenario drives the fixed mapping end to end:
 *
 *   leg 1 — session.start carrying mcpServers routes onto `hermes acp`
 *           (the ACP transport); the prompt triggers a dangerous-command
 *           approval; the scenario answers "always" and requires the
 *           request.resolved echo.
 *   leg 2 — a fresh session on the plain WS transport re-runs the same
 *           command: a real allow_always grant lives in the builder
 *           profile's command_allowlist, so nothing may re-ask.
 *
 * Modes:
 *   stub (default): scratch HERMES_HOME + `lilos-stub` provider
 *     (packages/engine-hermes/scripts/openai_stub.py). No real LLM is signed
 *     in on this VM.
 *   real: HERMES_PROVIDER + HERMES_MODEL set -> the operator's real
 *     ~/.hermes, untouched (Oscar's Mac: HERMES_PROVIDER=qwen
 *     HERMES_MODEL=<model> scripts/live/133-acp-always.sh).
 *
 * Prints PASS/FAIL plus a summary line; exit 0 = pass.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STUB_PY = join(
  ROOT,
  "packages",
  "engine-hermes",
  "scripts",
  "openai_stub.py",
);

const HERMES_BIN = process.env.HERMES_BIN ?? "hermes";
const STUB_PORT = Number(process.env.STUB_PORT ?? 8378);
const PROVIDER = process.env.HERMES_PROVIDER ?? "";
const MODEL = process.env.HERMES_MODEL ?? "";
const STUB_MODE = !PROVIDER;
const WAIT_MS = STUB_MODE ? 15_000 : 120_000;
const SCENARIO_CAP_MS = STUB_MODE ? 90_000 : 300_000;

const HOME = process.env.HOME ?? tmpdir();
const BUILDER_HOME = join(HOME, ".hermes", "profiles", "builder");

const children: { kill(): void }[] = [];
const killAll = () => {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* gone */
    }
  }
};
process.on("exit", killAll);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

let env: Record<string, string> = {};
let args: string[] = [];
let provider = PROVIDER;
let model = MODEL;

if (STUB_MODE) {
  // Same provisioning as packages/engine-hermes/scripts/live-hermes.ts: a
  // stable scratch profile dir for `lilos-stub` + a real `builder` profile
  // (profiles live in the global ~/.hermes/profiles/, not HERMES_HOME).
  const home =
    process.env.LILOS_STUB_HOME ??
    join(HOME, ".hermes", "profiles", "lilos-stub");
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  const stubConfig = `model:
  provider: lilos-stub
  default: stub-1
custom_providers:
  - name: lilos-stub
    base_url: "http://127.0.0.1:${STUB_PORT}/v1"
    api_key: "sk-lilos-stub"
    api_mode: chat_completions
    models:
      - stub-1
`;
  const extraConfig = `tools:
  tool_search:
    enabled: "off"
onboarding:
  seen:
    profile_build_offered: true
approvals:
  mode: manual
  timeout: 300
compression:
  in_place: false
  threshold_tokens: 400000
  protect_last_n: 1
  protect_first_n: 1
  min_tail_user_messages: 1
`;
  if (!existsSync(BUILDER_HOME)) mkdirSync(BUILDER_HOME, { recursive: true });
  writeFileSync(join(BUILDER_HOME, "config.yaml"), stubConfig + extraConfig);
  writeFileSync(
    join(BUILDER_HOME, "SOUL.md"),
    "You are Builder. Own the branch, keep diffs small, show your work.\n",
  );
  // Sessions may also run under the built-in default profile whose home is
  // the real ~/.hermes — register lilos-stub there too.
  const realConfigPath = join(HOME, ".hermes", "config.yaml");
  if (existsSync(realConfigPath)) {
    const real = readFileSync(realConfigPath, "utf8");
    if (!/^custom_providers:/m.test(real) && !real.includes("name: lilos-stub"))
      appendFileSync(
        realConfigPath,
        `\ncustom_providers:\n  - name: lilos-stub\n    base_url: "http://127.0.0.1:${STUB_PORT}/v1"\n    api_key: "sk-lilos-stub"\n    api_mode: chat_completions\n    models:\n      - stub-1\n`,
      );
  }
  writeFileSync(join(home, "config.yaml"), stubConfig + extraConfig);
  env = { HERMES_HOME: home, HERMES_SERVE_TIMEOUT_MS: "240000" };
  provider = "lilos-stub";
  model = "stub-1";
  args = ["--isolated"];
  console.log(`[133] STUB mode — HERMES_HOME=${home} stub port=${STUB_PORT}`);
  const stub = spawn("python3", [STUB_PY, "--port", String(STUB_PORT)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(stub);
  await new Promise<void>((resolve, reject) => {
    let buf = "";
    const to = setTimeout(
      () => reject(new Error(`stub did not start: ${buf}`)),
      10_000,
    );
    stub.stdout?.on("data", (d) => {
      buf += d;
      if (buf.includes("openai_stub on")) {
        clearTimeout(to);
        resolve();
      }
    });
    stub.on("exit", (c) => reject(new Error(`stub exited ${c}: ${buf}`)));
  });
} else {
  console.log(
    `[133] REAL mode — provider=${provider} model=${model || "(profile default)"}`,
  );
}

// A stale grant from an earlier run would auto-approve the trigger command
// and leg 1's request.opened would never fire — scrub it before both legs.
const allowlistBefore = (() => {
  const cfg = join(BUILDER_HOME, "config.yaml");
  const text = existsSync(cfg) ? readFileSync(cfg, "utf8") : "";
  const lines = text.split("\n");
  const i = lines.findIndex((l) => /^command_allowlist:/.test(l));
  let removed: string[] = [];
  if (i >= 0) {
    let j = i + 1;
    while (j < lines.length && /^[ \t]+\S/.test(lines[j])) j++;
    removed = lines.splice(i, j - i);
    writeFileSync(cfg, lines.join("\n"));
  }
  return removed.join("\n");
})();
if (allowlistBefore)
  console.log("[133] scrubbed stale command_allowlist from builder profile");

const hermes = await startHermesServe({
  bin: HERMES_BIN,
  args,
  env,
  timeoutMs: Number(env.HERMES_SERVE_TIMEOUT_MS ?? 240_000),
});
const gateway = await HermesGateway.connect(
  `ws://127.0.0.1:${hermes.port}/api/ws?token=${hermes.token}`,
);
const engine = new HermesEngine({
  gateway,
  provider,
  model,
  acp: { bin: HERMES_BIN, env },
});
const conn = connectInMemory(engine);
const h = new Harness(conn, WAIT_MS);

// The scenario starts sessions as agent "builder"; real mode seeds the
// profile via the engine when absent (stub mode provisioned it above).
{
  const { agents } = (await h.request("agents.list")) as {
    agents: { id: string }[];
  };
  if (!agents.some((a) => a.id === "builder")) {
    if (STUB_MODE)
      throw new Error(
        "builder profile missing — stub mode should have provisioned it",
      );
    await h.request("agents.create", {
      name: "builder",
      description: "LilOS conformance seed agent",
      soul: "You are Builder. Own the branch, keep diffs small, show your work.",
      ...(model ? { model } : {}),
    });
    console.log('[133] seeded "builder" profile via agents.create');
  }
}

// The conformance cwd must exist with a README the model can read/edit.
mkdirSync("/tmp/lilos-fake", { recursive: true });
if (!existsSync("/tmp/lilos-fake/README.md"))
  writeFileSync(
    "/tmp/lilos-fake/README.md",
    "# LilOS\n\nConformance workspace.\n",
  );

const scenario = SUITES.find((s) => s.capability === "mcp_servers")
  ?.scenarios[0];
if (!scenario) throw new Error("mcp_servers suite missing its scenario");

let failures = 0;
const t0 = Date.now();
try {
  await Promise.race([
    scenario.run(h),
    new Promise<never>((_, rej) =>
      setTimeout(
        () =>
          rej(new Error(`scenario exceeded ${SCENARIO_CAP_MS / 1000}s cap`)),
        SCENARIO_CAP_MS,
      ),
    ),
  ]);
  console.log(`PASS mcp_servers: ${scenario.id} (${Date.now() - t0}ms)`);
} catch (e) {
  failures++;
  console.log(
    `FAIL mcp_servers: ${scenario.id}\n     ${e instanceof Error ? e.message : e}`,
  );
}

// Evidence the grant persisted where Hermes keeps it: the builder profile's
// command_allowlist stores the dangerous-pattern label, so `chmod 777` lands
// as "world/other-writable permissions".
const cfgAfter = readFileSync(join(BUILDER_HOME, "config.yaml"), "utf8");
const granted = cfgAfter.includes("world/other-writable permissions");
console.log(
  `${granted ? "PASS" : "FAIL"} builder command_allowlist ${granted ? "carries" : "lacks"} the chmod-777 pattern grant`,
);
if (!granted) failures++;

console.log(
  `\nlive-133: ${failures === 0 ? "PASS" : "FAIL"} — ${scenario.id}` +
    (STUB_MODE
      ? "\nLIVE_ENGINE_UNAVAILABLE: stub provider; rerun with HERMES_PROVIDER+HERMES_MODEL for a real model"
      : `\nprovider=${provider} model=${model}`),
);
process.exit(failures ? 1 : 0);
