/**
 * `bun run live:hermes` — run the engine conformance suite against a real
 * `hermes serve` on this machine.
 *
 * Modes:
 *   default (stub):  deterministic OpenAI-compatible stub provider is spawned
 *                    (scripts/openai_stub.py) under an isolated HERMES_HOME
 *                    (~/.hermes/profiles/lilos-stub). Clearly labelled STUB —
 *                    no real LLM.
 *   real:            HERMES_PROVIDER=openai-codex HERMES_MODEL=qwen3.8-flash-next
 *                    bun run live:hermes  -> uses your signed-in default
 *                    Hermes profile; no stub, no alternate home.
 *
 * Env: HERMES_BIN (default "hermes"), STUB_PORT (default 8377),
 *      LILOS_STUB_HOME, HERMES_PROVIDER, HERMES_MODEL.
 *
 * What runs:
 *   1. Conformance suites through an in-process engine on a real WS gateway.
 *   2. Compression check: session.compress -> session.ref.changed -> next
 *      prompt still lands.
 *   3. Transport smoke: scripts/serve.ts (Bun.serve WS) over a second
 *      hermes serve — exercises the shipping entry point end to end.
 *
 * Exits non-zero unless every scenario passes.
 */
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
  connectWs,
  Harness,
  type Scenario,
  SUITES,
} from "@lilos/engine-conformance";
import {
  connectInMemory,
  HermesEngine,
  HermesGateway,
  startHermesServe,
} from "../src/index.js";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const STUB_PY = join(PKG, "scripts", "openai_stub.py");
const SERVE_TS = join(PKG, "scripts", "serve.ts");

const HERMES_BIN = process.env.HERMES_BIN ?? "hermes";
const STUB_PORT = Number(process.env.STUB_PORT ?? 8377);
const PROVIDER = process.env.HERMES_PROVIDER ?? "";
const MODEL = process.env.HERMES_MODEL ?? "";
const STUB_MODE = !PROVIDER;

// #50 AC-2 — real-model turns take ~60-120s; the stub answers in ms. One
// per-event wait covers a slow turn; the scenario cap bounds a scenario that
// loops asks. `prompt` requests have no timeout of their own — the cap is
// what turns a stuck scenario into a FAIL line instead of a hung run.
const WAIT_MS = STUB_MODE ? 15_000 : 120_000;
const SCENARIO_CAP_MS = STUB_MODE ? 90_000 : 300_000;
const withCap = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(
        () =>
          rej(
            new Error(`scenario exceeded the ${SCENARIO_CAP_MS / 1000}s cap`),
          ),
        SCENARIO_CAP_MS,
      ).unref(),
    ),
  ]);

const BUILDER_HOME = join(
  process.env.HOME ?? tmpdir(),
  ".hermes",
  "profiles",
  "builder",
);

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
  // Stable profile dir: first run provisions, later runs are warm.
  const home =
    process.env.LILOS_STUB_HOME ??
    join(process.env.HOME ?? tmpdir(), ".hermes", "profiles", "lilos-stub");
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
      - stub-2
`;
  // `builder` must exist BEFORE serve starts (conformance session.start uses
  // it) and must carry the stub provider itself — profiles.create mirrors
  // credentials but not custom_providers definitions, and profiles live in
  // the global ~/.hermes/profiles/, not inside HERMES_HOME.
  const extraConfig = `tools:
  tool_search:
    enabled: "off"
onboarding:
  seen:
    profile_build_offered: true
approvals:
  mode: manual
  timeout: 60
compression:
  in_place: false
  threshold_tokens: 18000
  protect_last_n: 1
  protect_first_n: 1
  min_tail_user_messages: 1
`;
  const builderHome = BUILDER_HOME;
  if (!existsSync(builderHome)) mkdirSync(builderHome, { recursive: true });
  // Sessions run under the builder profile: it needs the same approvals and
  // compression knobs as the home config (profile config wins inside it).
  writeFileSync(join(builderHome, "config.yaml"), stubConfig + extraConfig);
  writeFileSync(
    join(builderHome, "SOUL.md"),
    "You are Builder. Own the branch, keep diffs small, show your work.\n",
  );
  // Sessions also run under the built-in `default` profile (conformance
  // starts with agents.list[0]), whose home is the real ~/.hermes — register
  // the stub provider there too or its turns can't resolve `lilos-stub`.
  const realConfigPath = join(
    process.env.HOME ?? tmpdir(),
    ".hermes",
    "config.yaml",
  );
  if (existsSync(realConfigPath)) {
    const real = readFileSync(realConfigPath, "utf8");
    if (!/^custom_providers:/m.test(real) && !real.includes("name: lilos-stub"))
      appendFileSync(
        realConfigPath,
        `\ncustom_providers:\n  - name: lilos-stub\n    base_url: "http://127.0.0.1:${STUB_PORT}/v1"\n    api_key: "sk-lilos-stub"\n    api_mode: chat_completions\n    models:\n      - stub-1\n      - stub-2\n`,
      );
  }
  writeFileSync(
    join(home, "config.yaml"),
    `${stubConfig}tools:
  tool_search:
    enabled: "off"
onboarding:
  seen:
    profile_build_offered: true
approvals:
  mode: manual
  timeout: 60
compression:
  in_place: false
  threshold_tokens: 18000
  protect_last_n: 1
  protect_first_n: 1
  min_tail_user_messages: 1
`,
  );
  env = { HERMES_HOME: home, HERMES_SERVE_TIMEOUT_MS: "240000" };
  provider = "lilos-stub";
  model = "stub-1";
  args = ["--isolated"];
  console.log(`[live] STUB mode — HERMES_HOME=${home} stub port=${STUB_PORT}`);
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
    `[live] REAL mode — provider=${provider} model=${model || "(profile default)"}`,
  );
}

let failures = 0;
const report = (suite: string, s: Scenario, ms: number, e?: unknown) => {
  if (e) {
    failures++;
    console.log(
      `FAIL ${suite}: ${s.id}\n     ${e instanceof Error ? e.message : e}`,
    );
  } else console.log(`PASS ${suite}: ${s.id} (${ms}ms)`);
};

// ── 1+2: in-process engine on a real hermes serve ──────────────────────
const hermes = await startHermesServe({
  bin: HERMES_BIN,
  args,
  env,
  timeoutMs: Number(env.HERMES_SERVE_TIMEOUT_MS ?? 240_000),
});
const gateway = await HermesGateway.connect(
  `ws://127.0.0.1:${hermes.port}/api/ws?token=${hermes.token}`,
);
console.log(`handshake server_requests: ${gateway.serverRequests.join(",")}`);
const engine = new HermesEngine({
  gateway,
  provider,
  model,
  acp: { bin: HERMES_BIN, env },
});
const conn = connectInMemory(engine);
const h = new Harness(conn, WAIT_MS);

// The conformance suites start sessions as agent "builder": it must be a
// real Hermes profile. Stub mode pre-provisions it on disk (above); real
// mode creates it via the engine when absent (agents.create mirrors the
// active profile's credentials).
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
    console.log('[live] seeded "builder" profile via agents.create');
  }
}

// The approval/steer/resume scenarios need a turn parked on a pending ask —
// that only exists under `approvals.mode: manual`, whatever the operator's
// ambient profile does. Pin it on the `builder` profile the scenarios use.
{
  const cfg = join(BUILDER_HOME, "config.yaml");
  let text = existsSync(cfg) ? readFileSync(cfg, "utf8") : "";
  if (!text) text = "# lilos live-conformance profile\n";
  const lines = text.split("\n");
  const i = lines.findIndex((l) => /^approvals:\s*$/.test(l));
  if (i >= 0) {
    let j = i + 1;
    while (j < lines.length && /^[ \t]+\S/.test(lines[j])) j++;
    const block = lines.slice(i + 1, j);
    const modeIx = block.findIndex((l) => /^\s*mode:/.test(l));
    if (modeIx >= 0) block[modeIx] = "  mode: manual";
    else block.unshift("  mode: manual");
    const toIx = block.findIndex((l) => /^\s*timeout:/.test(l));
    if (toIx >= 0) block[toIx] = "  timeout: 300";
    else block.push("  timeout: 300");
    lines.splice(i + 1, j - i - 1, ...block);
  } else {
    lines.push("", "approvals:", "  mode: manual", "  timeout: 300");
  }
  writeFileSync(cfg, lines.join("\n"));
}

// Scenario cwds must exist with a README the model can actually read/edit —
// the prompts name the file, and a missing cwd/file invites tool loops.
for (const dir of ["/tmp/lilos-fake", "/tmp/lilos-conf", "/tmp/lilos-live"]) {
  mkdirSync(dir, { recursive: true });
  const readme = join(dir, "README.md");
  if (!existsSync(readme))
    writeFileSync(readme, "# LilOS\n\nConformance workspace.\n");
}

for (const suite of SUITES) {
  if (!suite.implemented) continue;
  for (const s of suite.scenarios as Scenario[]) {
    const t0 = Date.now();
    try {
      await withCap(s.run(h));
      report(suite.capability, s, Date.now() - t0);
    } catch (e) {
      report(suite.capability, s, Date.now() - t0, e);
    }
  }
}

// ── 2: compression rotates the stored session id -> session.ref.changed ─
{
  const t0 = Date.now();
  const id =
    "compression: session.compress -> session.ref.changed -> next prompt lands";
  try {
    const { sessionId } = (await h.request("session.start", {
      agent: "builder",
      cwd: "/tmp/lilos-live",
    })) as { sessionId: string };
    // Build real history: compression noops until it can fold several turns.
    // The prompt keeps the stub's LILOS_LONG long reply and asks a real model
    // for a long numbered list — either way the turns carry real tokens.
    for (let i = 0; i < 4; i++) {
      await withCap(
        h.request("prompt", {
          sessionId,
          content: [
            {
              type: "text",
              text: `LILOS_LONG turn ${i} — reply with the numbers ${i * 100 + 1} through ${i * 100 + 100}, one per line, then on the last line write exactly: LILOS_OK`,
            },
          ],
        }),
      );
    }
    // The LilOS session id is ours; the compress call wants the hermes sid.
    const s = engine.sessionFor(sessionId);
    if (!s) throw new Error(`no engine session for ${sessionId}`);
    const refWait = h.waitEvent(
      h.forSession(sessionId, (e) => e.type === "session.ref.changed"),
      STUB_MODE ? 30_000 : 150_000, // compress is an LLM call on a real build
    );
    const res = (await withCap(
      gateway.request("session.compress", {
        session_id: s.runtimeSid,
      }),
    )) as { compressed?: boolean; status?: string };
    if (!(res.compressed || res.status === "compressed"))
      throw new Error(
        `session.compress did not compress: ${JSON.stringify(res)}`,
      );
    const ev = await refWait;
    if (ev.type !== "session.ref.changed") throw new Error("unreachable");
    const { ref, previousRef } = ev.payload as {
      ref: string;
      previousRef: string;
    };
    if (!ref || !previousRef || ref === previousRef)
      throw new Error(`ref did not rotate: ${JSON.stringify(ev.payload)}`);
    // The next prompt lands on the rotated ref.
    const done = (await withCap(
      h.request("prompt", {
        sessionId,
        content: [{ type: "text", text: "reply with exactly: LILOS_OK" }],
      }),
    )) as { stopReason: string };
    if (done.stopReason !== "end_turn")
      throw new Error(`post-compress prompt ended ${done.stopReason}`);
    report("core", { id } as Scenario, Date.now() - t0);
  } catch (e) {
    report("core", { id } as Scenario, Date.now() - t0, e);
  }
}

conn.close();

// ── 3: transport smoke — scripts/serve.ts over a second hermes serve ────
{
  const t0 = Date.now();
  const id = "transport: serve.ts WS carries describe + a turn";
  try {
    const serve = spawn(
      "bun",
      [
        SERVE_TS,
        "--port",
        "0",
        "--hermes-bin",
        HERMES_BIN,
        "--provider",
        provider,
        ...(model ? ["--model", model] : []),
        ...(args.length ? ["--hermes-args", args.join(" ")] : []),
      ],
      { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ...env } },
    );
    children.push(serve);
    const url = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const to = setTimeout(
        () => reject(new Error(`serve did not print LISTENING:\n${buf}`)),
        240_000,
      );
      serve.stdout?.on("data", (d) => {
        buf += d;
        process.stdout.write(d);
        const m = buf.match(/LISTENING (ws:\/\/\S+)/);
        if (m) {
          clearTimeout(to);
          resolve(m[1]);
        }
      });
      serve.on("exit", (c) =>
        reject(new Error(`engine serve exited ${c}:\n${buf}`)),
      );
    });
    const ws = await connectWs(url);
    const wh = new Harness(ws, WAIT_MS);
    const { sessionId } = (await wh.request("session.start", {
      agent: "builder",
      cwd: "/tmp/lilos-live",
    })) as { sessionId: string };
    const done = (await withCap(
      wh.request("prompt", {
        sessionId,
        content: [{ type: "text", text: "reply with exactly: LILOS_OK" }],
      }),
    )) as { stopReason: string };
    if (done.stopReason !== "end_turn")
      throw new Error(`smoke prompt ended ${done.stopReason}`);
    ws.close();
    serve.kill("SIGTERM");
    report("core", { id } as Scenario, Date.now() - t0);
  } catch (e) {
    report("core", { id } as Scenario, Date.now() - t0, e);
  }
}

await engine.close();
await hermes.close();

if (failures) {
  console.log(`[live] ${failures} scenario(s) FAILED`);
  process.exit(1);
}
console.log(
  `[live] all scenarios passed${STUB_MODE ? " (STUB provider)" : ` (${provider} / ${model || "default"})`}`,
);
process.exit(0);
