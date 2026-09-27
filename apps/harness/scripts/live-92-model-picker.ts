/**
 * Issue #92 live leg: the real relay+harness over `hermes serve` — pick a
 * model + provider + effort + fast (the composer picker's wire call), and the
 * next turn's answer is stamped with them; `models.list {refresh:true}` and
 * the LilOS-owned `settings` hide list round-trip.
 *
 * Driven by scripts/live/92-model-picker.sh:
 *   default   — `hermes serve` against a deterministic OpenAI stub (STUB)
 *   real      — HERMES_PROVIDER + HERMES_MODEL env -> your signed-in engine
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

const relayHome = mkdtempSync(join(tmpdir(), "lilos92-relay-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos92-harness-"));

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

launch("harness", ["bun", "apps/harness/src/index.ts"], {
  LILOS_RELAY_URL: relayUrl,
  LILOS_RELAY_TOKEN: relayToken,
  LILOS_HARNESS_HOME: harnessHome,
  LILOS_WORKDIR: join(harnessHome, "work"),
  LILOS_ENGINE: engineKind,
  LILOS_REPO_ROOT: repoRoot,
});
out(`harness launched (engine=${engineKind})`);

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-92", version: "0" },
});
await user.connect().catch((e) => fail(`connect: ${e}`));

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
{
  const deadline = Date.now() + 60_000;
  let eng = await engineStatus();
  while (!canModels(eng) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    eng = await engineStatus();
  }
  if (!canModels(eng))
    fail(`engine lacks the models capability: ${JSON.stringify(eng ?? null)}`);
}

// ── AC-1 live: every authenticated provider's models, grouped ─────────
const host = await engineStatus();
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
const alt =
  models.find((m) => m.id !== first.model) ??
  models.at(1) ??
  fail("catalog has no alternate model to pick");
const pick: {
  conversationId: string;
  model: string;
  provider?: string;
  effort?: string;
  fast?: boolean;
} = { conversationId: conversation.id, model: alt.id };
if (alt.provider) pick.provider = alt.provider;
// A non-default effort, when the model reports a ladder.
if (alt.efforts && alt.efforts.length > 1) {
  pick.effort =
    alt.efforts.find((e) => e !== alt.defaultEffort) ?? alt.efforts[0];
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

cleanup();
console.log(
  "RESULT: PASS (AC-1 catalog+providers, AC-2/3/4 pick->turn, AC-6 refresh, AC-7 settings, AC-8 verbatim id)",
);
process.exit(0);
