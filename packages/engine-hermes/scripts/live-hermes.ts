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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  writeFileSync(
    join(home, "config.yaml"),
    `model:
  provider: "custom:lilos-stub"
  model: "stub-1"
providers:
  lilos-stub:
    base_url: "http://127.0.0.1:${STUB_PORT}/v1"
    api_key: "stub"
    api_mode: chat_completions
    model: "stub-1"
tools:
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
  provider = "custom:lilos-stub";
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
const h = new Harness(conn);

for (const suite of SUITES) {
  if (!suite.implemented) continue;
  for (const s of suite.scenarios as Scenario[]) {
    const t0 = Date.now();
    try {
      await s.run(h);
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
    for (let i = 0; i < 4; i++) {
      await h.request("prompt", {
        sessionId,
        content: [{ type: "text", text: `LILOS_LONG turn ${i}` }],
      });
    }
    // The LilOS session id is ours; the compress call wants the hermes sid.
    const s = engine.sessionFor(sessionId);
    if (!s) throw new Error(`no engine session for ${sessionId}`);
    const refWait = h.waitEvent(
      h.forSession(sessionId, (e) => e.type === "session.ref.changed"),
      30_000,
    );
    const res = (await gateway.request("session.compress", {
      session_id: s.runtimeSid,
    })) as { compressed?: boolean; status?: string };
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
    const done = (await h.request("prompt", {
      sessionId,
      content: [{ type: "text", text: "hello again" }],
    })) as { stopReason: string };
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
    const wh = new Harness(ws);
    const { sessionId } = (await wh.request("session.start", {
      agent: "builder",
      cwd: "/tmp/lilos-live",
    })) as { sessionId: string };
    const done = (await wh.request("prompt", {
      sessionId,
      content: [{ type: "text", text: "hi" }],
    })) as { stopReason: string };
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
