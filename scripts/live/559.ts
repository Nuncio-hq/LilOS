/**
 * Issue #559 live leg — a REAL agent call through the Agent Gateway:
 * engine-fake's `surfaces: context` prompt runs `mcp__lilos__context`
 * over the session's stdio `lilos mcp` server for real, and the answer
 * must carry `usage { used, window }` — the relay-persisted numbers of
 * the turn that just completed (AC-1/AC-2).
 *
 *   bun scripts/live/559.ts [--seconds N]
 *
 * Spawns the real relay + harness with LILOS_ENGINE=fake, opens a DM
 * thread, sends turn 1 so `turn.completed.usage` lands on the
 * conversation row, then turn 2 = `surfaces: context` and captures the
 * `tool.completed` frame for `mcp__lilos__context` off the relay's
 * `engine.event` stream.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Relative import: scripts/ is not a workspace dir, so @lilos/* does not
// resolve here — the package resolves its own deps internally.
import { RelayClient } from "../../packages/client-runtime/src/index";
import { cleanup, freePort, launch, waitForFile } from "./lib/helpers";

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
const seconds = Number(arg("seconds", "90") ?? "90");

const out = (line: string) => console.log(`[live-559] ${line}`);
const relayHome = mkdtempSync(join(tmpdir(), "lilos559-relay-"));
const harnessHome = mkdtempSync(join(tmpdir(), "lilos559-harness-"));
const workdir = join(harnessHome, "work");
const fail = (line: string): never => {
  console.error(`[live-559] FAIL ${line}`);
  cleanup(relayHome, harnessHome);
  process.exit(1);
};
process.on("SIGINT", () => {
  cleanup(relayHome, harnessHome);
  process.exit(130);
});

const waitFor = async <T>(
  what: string,
  fn: () => T | undefined | Promise<T | undefined>,
  ms = seconds * 1000,
): Promise<T> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  return fail(`timed out waiting for ${what}`);
};

/* -------------------------------- boot ---------------------------------- */

const relayPort = await freePort();
const feedPort = await freePort();
launch("relay", ["bun", "apps/relay/src/index.ts"], {
  LILOS_RELAY_HOME: relayHome,
  LILOS_RELAY_PORT: String(relayPort),
});
const relayToken = await waitForFile(join(relayHome, "relay-token")).catch(
  (e) => fail(`${e}`),
);
const relayUrl = `ws://127.0.0.1:${relayPort}/ws`;
out(`relay ws ${relayUrl}`);

launch("harness", ["bun", "apps/harness/src/index.ts"], {
  LILOS_RELAY_URL: relayUrl,
  LILOS_RELAY_TOKEN: relayToken,
  LILOS_HARNESS_HOME: harnessHome,
  LILOS_WORKDIR: workdir,
  LILOS_ENGINE: "fake",
  LILOS_FEED_PORT: String(feedPort),
  LILOS_REPO_ROOT: repoRoot,
});
await waitFor("harness feed", async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${feedPort}/host`, {
      method: "OPTIONS",
    });
    return res.status === 204 ? true : undefined;
  } catch {
    return undefined;
  }
});
out(`harness up (engine=fake)`);

const user = new RelayClient({
  url: relayUrl,
  token: relayToken,
  client: { name: "lilos-live-559", version: "0" },
});
await user.connect().catch((e) => fail(`relay connect: ${e}`));

const { employee } = await user.request<{ employee: { id: string } }>(
  "employees.create",
  { name: "Ada", role: "engineer" },
);
const { channel } = await user.request<{
  channel: { id: string; employeeId: string };
}>("channels.openDm", { employeeId: employee.id });
await user.request("channel.subscribe", { channelId: channel.id });
out(`dm channel ${channel.id}`);

/* The mcp__lilos__context completion lands here off the engine.event push. */
let contextCall: { status: string; output?: string } | undefined;
user.onEvent((method, params) => {
  if (method !== "engine.event") return;
  const evt = (
    params as { event?: { type?: string; payload?: Record<string, unknown> } }
  ).event;
  if (
    evt?.type === "tool.completed" &&
    evt.payload?.tool === "mcp__lilos__context"
  ) {
    contextCall = {
      status: String(evt.payload.status),
      output:
        typeof evt.payload.output === "string" ? evt.payload.output : undefined,
    };
  }
});

const convRow = async () => {
  const r = await user.request<{
    conversations: {
      id: string;
      usage?: { context?: number; contextWindow?: number };
    }[];
  }>("conversations.list", { channelId: channel.id });
  return r.conversations.find((c) => c.id === conversation.id);
};

/* ------- turn 1: any prompt — its turn.completed seeds conv.usage -------- */

const { conversation } = await user.request<{
  conversation: { id: string };
}>("conversations.open", {
  channelId: channel.id,
  text: "say hi",
  access: "full",
  title: `context-usage leg ${Date.now().toString(36)}`,
});
out(`conversation ${conversation.id}`);

const messages = user.channelMessages(channel.id);
await waitFor("turn 1 answer", () =>
  messages
    .get()
    .messages.some(
      (m) =>
        m.authorKind === "employee" && m.conversationId === conversation.id,
    )
    ? true
    : undefined,
);
const seeded = await waitFor("conversation.usage persisted", async () => {
  const row = await convRow();
  return row?.usage ? row.usage : undefined;
});
out(
  `conversation.usage seeded: context=${String(seeded.context)} ` +
    `window=${String(seeded.contextWindow)}`,
);

/* ------- turn 2: the agent calls lilos_context for real -------------------- */

await user.request("messages.post", {
  channelId: channel.id,
  conversationId: conversation.id,
  authorId: "user",
  authorKind: "user",
  text: "surfaces: context",
});

const call = await waitFor("mcp__lilos__context tool.completed", () =>
  contextCall?.status === "completed" && contextCall.output
    ? contextCall
    : undefined,
);
out(`mcp__lilos__context completed (${call.output?.length ?? 0} bytes)`);

const parsed = ((): {
  employee?: { name?: string };
  thread?: { id?: string };
  usage?: { used?: number; window?: number };
} => {
  try {
    return JSON.parse(call.output ?? "") as never;
  } catch (e) {
    return fail(
      `context output is not JSON: ${e} — ${call.output?.slice(0, 200)}`,
    );
  }
})();
out(`context result: ${call.output}`);

if (parsed.thread?.id !== conversation.id)
  fail(`bound thread mismatch: ${parsed.thread?.id} != ${conversation.id}`);
const usage =
  parsed.usage ?? fail(`usage missing: ${call.output?.slice(0, 200)}`);
if (typeof usage.used !== "number" || typeof usage.window !== "number")
  fail(`usage.used/window not numbers: ${JSON.stringify(usage)}`);
if (usage.used !== seeded.context)
  fail(`used ${usage.used} != persisted context ${String(seeded.context)}`);
if (usage.window !== seeded.contextWindow)
  fail(`window ${usage.window} != persisted ${String(seeded.contextWindow)}`);

out(
  `PASS — lilos_context answers usage ` +
    `{ used: ${usage.used}, window: ${usage.window} }`,
);
cleanup(relayHome, harnessHome);
console.log("[live-559] PASS");
process.exit(0);
