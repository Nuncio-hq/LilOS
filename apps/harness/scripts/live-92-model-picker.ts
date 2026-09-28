/**
 * Issue #92 live leg: the real relay+harness over `hermes serve` — pick a
 * model + provider + effort + fast (the composer picker's wire call), and the
 * next turn's answer is stamped with them; `models.list {refresh:true}` and
 * the LilOS-owned `settings` hide list round-trip.
 *
 * Driven by scripts/live/92-model-picker.sh:
 *   default   — `hermes serve` against a deterministic OpenAI stub (STUB)
 *   real      — HERMES_PROVIDER + HERMES_MODEL env -> your signed-in engine
 *     knobs   — LIVE_ALT_PROVIDER/LIVE_ALT_MODEL pick the switch target
 *               (default: a different authenticated provider's model),
 *               LIVE_EFFORT sets the effort verbatim (a provider's accepted
 *               set can differ from the reported ladder — hpc takes only
 *               low/medium/xhigh). `hermes serve` boot budget comes from
 *               HERMES_SERVE_TIMEOUT_MS (serve.ts default 240s) + margin.
 *
 * The engine runs on a throwaway HERMES_HOME the shell prepared (the real
 * ~/.hermes is never touched). Children launch detached so cleanup kills
 * each process GROUP — the harness's `hermes serve` grandchild dies with
 * its parent; nothing the user had running is signalled.
 *
 * Exits 0 only when every check passes; prints a PASS/FAIL summary.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayClient } from "@lilos/client-runtime";
import type { AppMessage, Conversation } from "@lilos/contracts/app";

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const engineKind = process.env.LILOS_ENGINE ?? "hermes";
const seconds = Number(process.env.LILOS_LIVE_SECONDS ?? "180");

const out = (line: string) => console.log(`[live-92] ${line}`);
const fail = (line: string): never => {
  console.error(`[live-92] FAIL ${line}`);
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
// The harness feed binds a fixed port by default — a packaged LilOS.app left
// running on the same Mac would collide, so this run takes a free one.
const feedPort = await freePort();

const relayHome = mkdtempSync(join(tmpdir(), "lilos92-relay-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos92-harness-"));

const procs: ChildProcess[] = [];
const launch = (name: string, cmd: string[], env: Record<string, string>) => {
  const child = spawn(cmd[0] ?? "bun", cmd.slice(1), {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    /* own process group: SIGTERM to -pid reaps the whole subtree the child
       spawned (engine-hermes' `hermes serve` included). */
    detached: true,
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
  for (const p of procs) {
    // Kill the child's process group (detached above) — grandchildren like
    // `hermes serve` go with it. pid fallback if the group is already gone.
    try {
      if (p.pid) process.kill(-p.pid, "SIGTERM");
    } catch {
      p.kill("SIGTERM");
    }
  }
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

launch("harness", ["bun", "apps/harness/src/index.ts"], {
  LILOS_RELAY_URL: relayUrl,
  LILOS_RELAY_TOKEN: relayToken,
  LILOS_HARNESS_HOME: harnessHome,
  LILOS_WORKDIR: join(harnessHome, "work"),
  LILOS_ENGINE: engineKind,
  LILOS_FEED_PORT: String(feedPort),
  LILOS_REPO_ROOT: repoRoot,
});
out(`harness launched (engine=${engineKind})`);

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-92", version: "0" },
});
{
  let lastErr: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      await user.connect();
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (lastErr !== undefined) fail(`connect: ${lastErr}`);
}

type ModelRow = {
  id: string;
  name?: string;
  provider?: string;
  efforts?: string[];
  defaultEffort?: string;
  fast?: boolean;
};
type EngineBlob = {
  capabilities?: { id: string; detail?: { refreshable?: boolean } }[];
  models?: ModelRow[];
  providers?: { id: string; name?: string }[];
};
const engineStatus = async () =>
  (
    await user
      .request<{ engine?: EngineBlob }>("system.status", {})
      .catch(() => ({}) as { engine?: EngineBlob })
  ).engine;
const canModels = (e?: EngineBlob) =>
  e?.capabilities?.some((c) => c.id === "models") ?? false;
/* `hermes serve` can take ~194s to report ready on a cold Mac; serve.ts
   allows HERMES_SERVE_TIMEOUT_MS (default 240s). Wait that long plus a
   margin, printing progress so a slow boot doesn't read as a hang. */
const bootBudgetMs =
  Number(process.env.HERMES_SERVE_TIMEOUT_MS ?? "240000") + 30_000;
{
  const start = Date.now();
  const deadline = start + bootBudgetMs;
  let eng = await engineStatus();
  let announced = 0;
  while (!canModels(eng) && Date.now() < deadline) {
    const waited = Math.floor((Date.now() - start) / 1000);
    if (waited - announced >= 15) {
      announced = waited;
      out(`waiting for the models capability… ${waited}s elapsed`);
    }
    await new Promise((r) => setTimeout(r, 1000));
    eng = await engineStatus();
  }
  if (!canModels(eng))
    fail(
      `engine lacks the models capability after ${Math.round(bootBudgetMs / 1000)}s: ${JSON.stringify(eng ?? null)}`,
    );
}

// ── AC-1 live: every authenticated provider's models, grouped ─────────
/* The capability can arrive a beat before the catalog fills on a slow boot —
   poll until the status reports models rather than failing on the first
   empty snapshot. */
let host: EngineBlob | undefined;
{
  const start = Date.now();
  const deadline = start + 60_000;
  let announced = 0;
  while (Date.now() < deadline) {
    host = await engineStatus();
    if (host?.models?.length) break;
    const waited = Math.floor((Date.now() - start) / 1000);
    if (waited - announced >= 15) {
      announced = waited;
      out(`waiting for the model catalog… ${waited}s elapsed`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const models = host?.models ?? [];
const providers = host?.providers ?? [];
if (models.length < 2)
  fail(`need >=2 models to switch between; got ${JSON.stringify(models)}`);
out(
  `catalog: ${providers.map((p) => p.id).join(", ") || "?"} -> ${models
    .map((m) => `${m.provider ?? "?"}:${m.id}`)
    .join(", ")}`,
);

// ── AC-6 live: models.list {refresh:true} rides through when declared ──
const refreshable = host?.capabilities?.some(
  (c) =>
    c.id === "models" &&
    (c.detail as { refreshable?: boolean })?.refreshable === true,
);
const fresh = await user.request<{ models: ModelRow[] }>("models.list", {
  refresh: true,
});
if (!Array.isArray(fresh.models) || fresh.models.length === 0)
  fail("models.list {refresh:true} returned no models");
out(
  `refresh:${refreshable ? "declared" : "undeclared"} -> ${fresh.models.length} models`,
);

// ── AC-7 live: the hide list is relay-owned (settings.get/set) ─────────
const hide = { providers: [], models: ["___nothing___"] };
await user.request("settings.set", { key: "modelVisibility", value: hide });
const { value: gotHide } = await user.request<{ value: unknown }>(
  "settings.get",
  { key: "modelVisibility" },
);
if (JSON.stringify(gotHide) !== JSON.stringify(hide))
  fail(`settings round-trip mismatch: ${JSON.stringify(gotHide)}`);
await user.request("settings.set", {
  key: "modelVisibility",
  value: { providers: [], models: [] },
});
out("settings.set/get round-trip ok (relay-owned hide list)");

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: "Ada", role: "engineer" },
);
const { channel } = await user.request<{
  channel: { id: string; employeeId: string };
}>("channels.openDm", { employeeId: employee.id });
out(`dm channel ${channel.id}`);

const waitFor = async <T>(
  what: string,
  poll: () => Promise<T | undefined>,
  ms = seconds * 1000,
): Promise<T> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await poll();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  return fail(`timed out waiting for ${what}`);
};
const conv = async (id: string) =>
  (
    (
      await user.request<{ conversations: Conversation[] }>(
        "conversations.list",
        { channelId: channel.id },
      )
    ).conversations ?? []
  ).find((c) => c.id === id);
const convMessages = async (convId: string) =>
  (
    await user.request<{ messages: AppMessage[] }>("messages.list", {
      channelId: channel.id,
    })
  ).messages.filter((m) => m.conversationId === convId);
const answer = async (convId: string) =>
  waitFor(`answer on ${convId}`, async () =>
    (await convMessages(convId)).find(
      (m) => m.authorKind === "employee" && m.authorId !== "system",
    ),
  );

// ── AC-5 live: the first turn answers on the employee default ──────────
const { conversation } = await user.request<{
  conversation: { id: string };
}>("conversations.open", {
  channelId: channel.id,
  text: "hello — say hi",
  title: "model picker v2 live",
});
const first = await answer(conversation.id);
out(`turn 1 answered (model=${first.model ?? "?"})`);

// ── AC-2/3/4 live: pick model + provider + effort + fast; next turn ────
// Stub leg: stay on lilos-stub (other providers would call a real API), and
// prefer the model whose id contains "/" — that exercises AC-8 for real.
// Live leg: prefer a model from a DIFFERENT authenticated provider than the
// ambient one (a cross-provider switch is the point), falling back to any
// other model. LIVE_ALT_MODEL (+LIVE_ALT_PROVIDER) pin the target exactly.
const stubLeg = process.env.HERMES_PROVIDER === "lilos-stub";
const ambientProvider = models.find((m) => m.id === first.model)?.provider;
const envAlt = (() => {
  const want = process.env.LIVE_ALT_MODEL;
  if (!want) return undefined;
  const provider = process.env.LIVE_ALT_PROVIDER;
  return (
    models.find(
      (m) =>
        m.id === want && (provider === undefined || m.provider === provider),
    ) ??
    fail(
      `LIVE_ALT_MODEL=${want}${provider ? ` provider=${provider}` : ""} is not in the catalog`,
    )
  );
})();
const alt =
  envAlt ??
  (stubLeg
    ? (models.find((m) => m.provider === "lilos-stub" && m.id.includes("/")) ??
      models.find((m) => m.provider === "lilos-stub"))
    : (models.find(
        (m) => m.id !== first.model && m.provider !== ambientProvider,
      ) ??
      models.find((m) => m.id !== first.model) ??
      models.at(1))) ??
  fail("catalog has no alternate model to pick");
const pick: {
  conversationId: string;
  model: string;
  provider?: string;
  effort?: string;
  fast?: boolean;
} = { conversationId: conversation.id, model: alt.id };
if (alt.provider) pick.provider = alt.provider;
/* Effort: LIVE_EFFORT wins verbatim — a provider's accepted set can differ
   from the reported ladder (hpc takes only low/medium/xhigh, and Hermes
   can't know that). Otherwise a non-default stop from the ladder. */
const envEffort = process.env.LIVE_EFFORT;
if (envEffort !== undefined) {
  pick.effort = envEffort;
} else if (alt.efforts && alt.efforts.length > 1) {
  /* Prefer a non-default, non-"none" stop: "none" unsets reasoning, which
     is correct but leaves nothing on the wire for the stub check to see. */
  pick.effort =
    alt.efforts.find((e) => e !== alt.defaultEffort && e !== "none") ??
    alt.efforts.find((e) => e !== alt.defaultEffort) ??
    alt.efforts[0];
}
if (alt.fast) pick.fast = true;
out(
  `picking ${JSON.stringify({ model: pick.model, provider: pick.provider, effort: pick.effort, fast: pick.fast })}`,
);
await user.request("conversations.setModel", pick);
const applied = await waitFor(`conversation.model=${alt.id}`, async () => {
  const c = await conv(conversation.id);
  return c?.model === alt.id ? c : undefined;
});
out(
  `pick applied: ${applied.model} effort=${applied.effort ?? "-"} fast=${applied.fast ?? "-"}`,
);

await user.request("messages.post", {
  channelId: channel.id,
  conversationId: conversation.id,
  text: "one more word please",
});
const second = await waitFor("second answer", async () =>
  (await convMessages(conversation.id)).find(
    (m) =>
      m.authorKind === "employee" &&
      m.authorId !== "system" &&
      m.id !== first.id,
  ),
);
// AC-8: the id is verbatim — never re-split on "/".
if (second.model !== pick.model)
  fail(`answer model is ${second.model ?? "?"}; expected ${pick.model}`);
if (pick.effort !== undefined && second.effort !== pick.effort)
  fail(`answer effort is ${second.effort ?? "?"}; expected ${pick.effort}`);
if (pick.fast === true && second.fast !== true)
  fail(`answer fast is ${second.fast ?? "?"}; expected true`);
out(
  `turn 2 answered on ${second.model} effort=${second.effort ?? "-"} fast=${second.fast ?? "-"} — pick took effect`,
);

/* #92 review — prove the pick reached the wire exactly once and the fast
   tier survived: a double apply (a stale pending_model_switch stash plus a
   replayed config.set) would run a second switch_model whose
   request_overrides reset silently drops the fast tier. (Hermes' switch
   marker is self-replacing, so a marker count can't catch that — the
   request's service_tier/speed can.) Stub leg only: a real provider can't
   be introspected, so the real leg relies on second.fast. */
if (stubLeg) {
  const logFile = process.env.STUB_REQUEST_LOG_FILE;
  const reqs = (logFile ? readFileSync(logFile, "utf8") : "")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const picked = reqs.filter((r) => r.model === pick.model);
  const last = picked[picked.length - 1];
  if (!last)
    fail(
      `no stub request carried model=${pick.model} — the pick never reached the wire (${JSON.stringify(reqs.map((r) => r.model))})`,
    );
  if (pick.fast === true && !last.service_tier && !last.speed)
    fail(
      `pick ran on ${String(pick.model)} but WITHOUT a fast tier — a second deferred apply dropped request_overrides`,
    );
  /* Effort is NOT wire-observable on a custom endpoint: Hermes only puts
     `reasoning` in extra_body for routes it knows are reasoning-capable
     (agent/reasoning_params.py::_supports_reasoning_extra_body — OpenRouter,
     Nous, GitHub Models, LM Studio, Ollama), never a plain chat_completions
     provider. `second.effort` above is the proof the pick applied. */
  out(
    `wire check ok: request on ${String(last.model)} tier=${String(last.service_tier ?? last.speed ?? "-")}`,
  );
}

cleanup();
console.log(
  "RESULT: PASS (AC-1 catalog+providers, AC-2/3/4 pick->turn, AC-6 refresh, AC-7 settings, AC-8 verbatim id)",
);
process.exit(0);
