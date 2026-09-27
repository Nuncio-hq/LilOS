/**
 * Issue #30 live leg: pick a model over the real relay+harness, the next
 * turn runs on it, and the answering message carries `turn.started.model`.
 *
 * Driven by scripts/live/30-model-picker.sh:
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
const seconds = Number(process.env.LILOS_LIVE_SECONDS ?? "120");

const out = (line: string) => console.log(`[live-30] ${line}`);
const fail = (line: string): never => {
  console.error(`[live-30] FAIL ${line}`);
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

const relayHome = mkdtempSync(join(tmpdir(), "lilos30-relay-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos30-harness-"));

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
  client: { name: "lilos-live-30", version: "0" },
});
await user.connect().catch((e) => fail(`connect: ${e}`));

// The harness reports engine status asynchronously — welcome.engineHost can
// still be `connected:false`; poll system.status until the catalog lands.
type EngineBlob = {
  capabilities?: { id: string }[];
  models?: { id: string }[];
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
// ── AC-1 live: the catalog the picker shows comes off the engine ──────
const host = await engineStatus();
const models = host?.models ?? [];
if (models.length < 2)
  fail(`need >=2 models to switch between; got ${JSON.stringify(models)}`);
out(`models capability on; catalog: ${models.map((m) => m.id).join(", ")}`);

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

// Session binds on first conversation; default model answers first.
const { conversation } = await user.request<{
  conversation: { id: string };
}>("conversations.open", {
  channelId: channel.id,
  text: "hello — say hi",
  title: "model picker live",
});
const listed = await user.request<{ conversations: { id: string }[] }>(
  "conversations.list",
  {},
);
out(`conversations.list -> ${listed.conversations.map((c) => c.id).join(",")}`);
const first = await answer(conversation.id);
out(`turn 1 answered (model=${first.model ?? "?"})`);

// Pick a different model — exactly what the composer picker's onModel sends.
const alt = models.find((m) => m.id !== first.model) ?? models.at(1);
const picked = alt?.id ?? fail("catalog has no alternate model to pick");
await user.request("conversations.setModel", {
  conversationId: conversation.id,
  model: picked,
});
const applied = await waitFor(`conversation.model=${picked}`, async () => {
  const c = await conv(conversation.id);
  return c?.model === picked ? c : undefined;
});
out(`pick applied: ${applied.model}`);

// ── AC-2 live: the next turn's answer is stamped with the picked model ──
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
if (second.model !== picked)
  fail(`answer model is ${second.model ?? "?"}; expected ${picked}`);
out(`turn 2 answered on ${second.model} — pick took effect`);

cleanup();
console.log("RESULT: PASS (AC-1 catalog live, AC-2 picked model answered)");
process.exit(0);
