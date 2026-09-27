/**
 * Issue #85 live leg: the default harness boots the REAL engine and a DM
 * round-trip answers through `hermes serve`.
 *
 * Driven by scripts/live/85-real-engine.sh:
 *   stub — `hermes serve` against a deterministic OpenAI stub (STUB label)
 *   real — HERMES_PROVIDER + HERMES_MODEL env -> your signed-in provider
 *
 * Crucially `LILOS_ENGINE` is left UNSET: the run only proves anything if
 * the harness's own default picks Hermes. Asserts:
 *   1. engine leg reports name `engine-hermes` (never `engine-fake`),
 *   2. a DM gets an employee reply,
 *   3. `system.status` legs print for the summary.
 *
 * Exits 0 only when every check passes.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayClient } from "@lilos/client-runtime";
import type {
  AppMessage,
  Conversation,
  SystemStatusResult,
} from "@lilos/contracts/app";

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const seconds = Number(process.env.LILOS_LIVE_SECONDS ?? "180");

const out = (line: string) => console.log(`[live-85] ${line}`);
const fail = (line: string): never => {
  console.error(`[live-85] FAIL ${line}`);
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
const relayHome = mkdtempSync(join(tmpdir(), "lilos85-relay-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos85-harness-"));

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

// AC-1: LILOS_ENGINE deliberately unset — the built default must be Hermes.
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
  client: { name: "lilos-live-85", version: "0" },
});
await user.connect().catch((e) => fail(`connect: ${e}`));

const systemStatus = async () =>
  await user
    .request<SystemStatusResult>("system.status", {})
    .catch(() => ({}) as SystemStatusResult);

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

// ── 1: the engine leg must name engine-hermes and be running ──────────
const status = await waitFor("engine leg", async () => {
  const s = await systemStatus();
  const eng = s.engine;
  if (eng?.name === "engine-fake")
    fail(
      "engine leg reports engine-fake — the default shipped the fake engine",
    );
  const leg = s.components?.find((c) => c.id === "engine");
  if (leg?.state === "down") fail(`engine leg down: ${leg.reason}`);
  return eng?.name && leg?.state === "ok" ? s : undefined;
});
const eng = status.engine;
out(
  `engine leg: name=${eng?.name} version=${eng?.version ?? "?"} model=${eng?.defaultModel ?? "(engine default)"}`,
);
if (eng?.name !== "engine-hermes")
  fail(`engine is ${eng?.name ?? "unknown"}, expected engine-hermes`);

// ── 2: a DM round-trip answered by a real hermes turn ──────────────────
const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: "Ada 85", role: "engineer", profile: "builder" },
);
const { channel } = await user.request<{ channel: { id: string } }>(
  "channels.openDm",
  { employeeId: employee.id },
);
const { conversation } = await user.request<{
  conversation: Conversation;
}>("conversations.open", {
  channelId: channel.id,
  text: "Reply with the single word READY",
  title: "#85 live",
});
out(`dm ${channel.id} -> conversation ${conversation.id}`);

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

// ── 3: status legs as Oscar sees them ──────────────────────────────────
const finalStatus = await systemStatus();
const legs = (finalStatus.components ?? [])
  .map((c) => `${c.id}=${c.state}(${c.reason})`)
  .join(" ");
out(`status: ${legs}`);

cleanup();
console.log("RESULT: PASS (default engine = engine-hermes, DM answered)");
process.exit(0);
