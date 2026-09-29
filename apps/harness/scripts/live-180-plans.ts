/**
 * Issue #180 live leg: a real Hermes turn that keeps a `todo` list streams
 * `plan.updated` (kind "tasks") through the harness feed — the same engine
 * protocol events the web app renders the Tasks card from.
 *
 * Driven by scripts/live/180.sh:
 *   stub — `hermes serve` against the OpenAI stub, which scripts one real
 *          `todo_list` tool call (STUB label — never a live-model claim)
 *   real — HERMES_PROVIDER + HERMES_MODEL env -> your signed-in provider;
 *          the prompt asks Hermes to keep the list itself
 *
 * Asserts, on the real EngineClient the web uses:
 *   1. `describe` declares the `plan` capability,
 *   2. a DM turn emits `plan.updated` kind "tasks" with >=2 steps,
 *   3. the turn finishes with an employee reply (round-trip health).
 *
 * Exits 0 only when every check passes.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineClient, RelayClient } from "@lilos/client-runtime";
import type {
  AppMessage,
  Conversation,
  SystemStatusResult,
} from "@lilos/contracts/app";
import type { EngineEvent } from "@lilos/contracts/engine";

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const seconds = Number(process.env.LILOS_LIVE_SECONDS ?? "180");

const out = (line: string) => console.log(`[live-180] ${line}`);
const fail = (line: string): never => {
  console.error(`[live-180] FAIL ${line}`);
  try {
    console.error(readFileSync(join(harnessHome, "harness.log"), "utf8"));
  } catch {
    /* no log file */
  }
  cleanup();
  process.exit(1);
};

const freePort = async () =>
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

const relayPort = await freePort();
const feedPort = await freePort();
const relayHome = mkdtempSync(join(tmpdir(), "lilos180-relay-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos180-harness-"));

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
  LILOS_RELAY_PORT: String(relayPort),
});
const waitForFile = async (path: string, ms = 15_000): Promise<string> => {
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
const relayUrl = `ws://127.0.0.1:${relayPort}/ws`;

/* The token file can land a tick before the socket accepts — wait for the
   HTTP listener before connecting, or the first connect races it. */
{
  const deadline = Date.now() + 15_000;
  for (;;) {
    const ok = await fetch(`http://127.0.0.1:${relayPort}/`, {
      signal: AbortSignal.timeout(1_000),
    })
      .then(() => true)
      .catch(() => false);
    if (ok) break;
    if (Date.now() > deadline) fail("relay never listened");
    await new Promise((r) => setTimeout(r, 200));
  }
}

launch("harness", ["bun", "apps/harness/src/index.ts"], {
  LILOS_RELAY_URL: relayUrl,
  LILOS_RELAY_TOKEN: relayToken,
  LILOS_HARNESS_HOME: harnessHome,
  LILOS_WORKDIR: join(harnessHome, "work"),
  LILOS_FEED_PORT: String(feedPort),
  LILOS_REPO_ROOT: repoRoot,
});
out("harness launched (LILOS_ENGINE unset — default must be hermes)");

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-180", version: "0" },
});
await user.connect().catch((e) => fail(`connect: ${e}`));

/* The same client the web app runs: feed socket + describe + session feeds. */
const feed = new EngineClient({ url: `ws://127.0.0.1:${feedPort}/ws` });

const waitFor = async <T>(
  what: string,
  poll: () => Promise<T | undefined>,
  ms = seconds * 1000,
): Promise<T> => {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    const v = await poll();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  return fail(
    `timed out waiting for ${what} — last status: ${JSON.stringify(last)}`,
  );
};

// ── engine leg must be engine-hermes ────────────────────────────────────
const status = await waitFor("engine leg", async () => {
  const s = await user
    .request<SystemStatusResult>("system.status", {})
    .catch(() => ({}) as SystemStatusResult);
  const eng = s.engine;
  if (eng?.name === "engine-fake")
    fail("engine leg reports engine-fake — expected engine-hermes");
  const leg = s.components?.find((c) => c.id === "engine");
  return eng?.name && leg?.state === "ok" ? s : undefined;
});
out(
  `engine leg: name=${status.engine?.name} model=${status.engine?.defaultModel ?? "?"}`,
);

// ── 1: describe declares the `plan` capability ──────────────────────────
const desc = await feed.connect().catch((e) => fail(`feed connect: ${e}`));
const planCap =
  desc.capabilities.find((c) => c.id === "plan") ??
  fail(
    `engine did not declare 'plan' — capabilities: ${desc.capabilities.map((c) => c.id).join(", ")}`,
  );
out(`plan capability: ${JSON.stringify(planCap.detail ?? {})}`);

// ── 2: a DM turn emits plan.updated kind "tasks" ────────────────────────
const planUpdates: Extract<EngineEvent, { type: "plan.updated" }>[] = [];
feed.onEvent((e) => {
  if (e.type === "plan.updated") planUpdates.push(e);
});

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: "Ada 180", role: "engineer", profile: "builder" },
);
const { channel } = await user.request<{ channel: { id: string } }>(
  "channels.openDm",
  { employeeId: employee.id },
);
const { conversation } = await user.request<{
  conversation: Conversation;
}>("conversations.open", {
  channelId: channel.id,
  text:
    process.env.LILOS_LIVE_PROMPT ??
    "Keep a todo list with 3 items for reorganising the readme — mark each in_progress then completed as you go.",
  title: "#180 live",
});
out(`dm ${channel.id} -> conversation ${conversation.id}`);

const updates = await waitFor("a plan.updated kind tasks", async () => {
  const tasks = planUpdates.filter((e) => e.payload.kind === "tasks");
  return tasks.length ? tasks : undefined;
});
const snap = updates.at(-1)?.payload;
out(
  `plan.updated x${updates.length}: planId=${snap?.planId} v${snap?.version} steps=${snap?.steps.length} ` +
    `statuses=${snap?.steps.map((s) => s.status).join(",")}`,
);
if ((snap?.steps.length ?? 0) < 2)
  fail(
    `task list too small (${snap?.steps.length} steps) — plan gate needs >= 2`,
  );
if (snap?.steps.some((s) => !s.text.trim()))
  fail("a plan.updated step has empty text");

// ── 3: the turn answers (round-trip health) ─────────────────────────────
const answer = await waitFor("an employee reply", async () => {
  const { messages } = await user.request<{ messages: AppMessage[] }>(
    "messages.list",
    { channelId: channel.id },
  );
  return messages.find(
    (m) =>
      m.conversationId === conversation.id &&
      m.authorKind === "employee" &&
      m.authorId !== "system",
  );
});
out(`reply: "${answer.text.slice(0, 120)}" (model=${answer.model ?? "?"})`);

cleanup();
console.log(
  `RESULT: PASS (engine-hermes declared plan, streamed ${updates.length} plan.updated, DM answered)`,
);
process.exit(0);
