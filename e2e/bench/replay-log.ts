/**
 * Issue #431 AC-1 — replay + memory benchmark.
 *
 * Boots the dev stack (relay + harness + vite via e2e/helpers/stack.ts —
 * vite is unused, the bench speaks relay WS), drives a synthetic N-turn
 * session through the real path (conversations.open once, then
 * messages.post per turn — the same calls the composer makes), then
 * measures what a fresh reload pays:
 *
 *   - `events.since {after:0}` result byte size + event count + round-trip
 *     ms, asked over the harness feed socket exactly like the client's
 *     resync does;
 *   - RSS of the stack's process group, split relay / harness / engine —
 *     the "doesn't grow in memory over days" half (the engine child's
 *     unbounded per-session event log is what the issue caps).
 *
 *   bun e2e/bench/replay-log.ts                  # 200 turns
 *   bun e2e/bench/replay-log.ts --turns 50
 *
 * Before/after protocol: run on main (or the pre-PR commit) and on the PR
 * head, diff the numbers into the PR body.
 */

import { execFileSync } from "node:child_process";
/* e2e/ is no workspace — reach the packages by relative path (their own
   node_modules resolve their inner @lilos/* imports). */
import { RelayClient } from "../../packages/client-runtime/src/index";
import type { EngineEvent } from "../../packages/contracts/src/engine/index";
import { bootStack, pickPorts } from "../helpers/stack";

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const TURNS = Math.max(1, Number(arg("turns", "200")) || 200);
const PROMPT = "md: blocks";
const USER_ID = "user";
const TICK = arg("tick", "2");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RssRow {
  pid: number;
  rssKb: number;
  role: "relay" | "harness" | "engine" | "vite" | "other";
  command: string;
}

/** Every process in the booted stack's detached group, classified. */
function stackRss(groupPid: number): RssRow[] {
  const pids = execFileSync("pgrep", ["-g", String(groupPid)], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(Number);
  const rows: RssRow[] = [];
  for (const pid of pids) {
    const out = execFileSync("ps", ["-o", "rss=,command=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    const m = /^\s*(\d+)\s+(.*)$/.exec(out);
    if (!m) continue;
    const command = m[2];
    const role: RssRow["role"] =
      /engine-fake\/scripts\/serve\.ts|lilos-engine-fake/.test(command)
        ? "engine"
        : /apps\/harness/.test(command)
          ? "harness"
          : /apps\/relay/.test(command)
            ? "relay"
            : /vite/.test(command)
              ? "vite"
              : "other";
    rows.push({ pid, rssKb: Number(m[1]), role, command });
  }
  return rows;
}

/** Raw JSON-RPC over the harness feed — the client's resync call verbatim. */
async function feedEventsSince(
  feedWs: string,
  sessionId: string,
  after: number,
): Promise<{ result: unknown; bytes: number; ms: number }> {
  const ws = new WebSocket(feedWs);
  const t0 = Date.now();
  const result = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("events.since timeout")),
      120_000,
    );
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "events.since",
          params: { sessionId, after },
        }),
      );
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as {
        id?: number;
        result?: unknown;
        error?: unknown;
      };
      if (msg.id !== 1) return; // buffered "event" notifications
      clearTimeout(timer);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.onerror = () => reject(new Error("feed socket failed"));
  }).finally(() => ws.close());
  const ms = Date.now() - t0;
  return { result, bytes: JSON.stringify(result).length, ms };
}

async function main() {
  const ports = await pickPorts();
  console.log(
    `[replay-log] booting stack relay=${ports.relay} feed=${ports.feed}`,
  );
  const stack = await bootStack("replaylog", ports, {
    LILOS_USER_NAME: "Oscar",
    ENGINE_FAKE_TICK: TICK,
  });
  try {
    const relay = new RelayClient({
      url: stack.relayWs,
      token: stack.relayToken,
    });
    // engine.event frames reach channel subscribers only.
    const completed = new Map<string, () => void>();
    relay.onEvent((method, params) => {
      if (method !== "engine.event") return;
      const p = params as {
        conversationId?: string;
        event?: EngineEvent;
      };
      if (p.event?.type !== "turn.completed") return;
      completed.get(p.conversationId ?? "")?.();
    });
    await relay.connect();
    for (let i = 0; i < 300 && !relay.directoryReady.get(); i++)
      await sleep(100);
    if (!relay.directoryReady.get())
      throw new Error("relay directory never loaded");

    const dm = relay.channels.get().find((c) => c.kind === "dm");
    if (!dm) throw new Error("no dm channel in the seeded stack");
    await relay.request("channel.subscribe", { channelId: dm.id });

    const waitTurn = async (conversationId: string) => {
      const done = new Promise<void>((resolve) =>
        completed.set(conversationId, resolve),
      );
      await Promise.race([
        done,
        sleep(60_000).then(() => {
          throw new Error(`turn never completed for ${conversationId}`);
        }),
      ]);
      completed.delete(conversationId);
    };

    // Turn 1 opens the conversation; later turns are thread replies.
    let convId: string | undefined;
    const started = Date.now();
    for (let i = 1; i <= TURNS; i++) {
      if (!convId) {
        const res = await relay.request<{
          conversation: { id: string };
        }>("conversations.open", {
          channelId: dm.id,
          authorId: USER_ID,
          text: PROMPT,
        });
        convId = res.conversation.id;
      } else {
        await relay.request("messages.post", {
          channelId: dm.id,
          conversationId: convId,
          authorId: USER_ID,
          authorKind: "user",
          text: PROMPT,
        });
      }
      const pending = waitTurn(convId);
      if (i % 25 === 0) console.log(`[replay-log] turn ${i}/${TURNS}`);
      await pending;
    }
    const runMs = Date.now() - started;

    // Conversation → engine session id (engineRef binds at session.start).
    let engineRef: string | null | undefined;
    for (let i = 0; i < 50 && !engineRef; i++) {
      const res = await relay.request<{
        conversations: { id: string; engineRef: string | null }[];
      }>("conversations.list", {});
      engineRef = res.conversations.find((c) => c.id === convId)?.engineRef;
      if (!engineRef) await sleep(200);
    }
    if (!engineRef) throw new Error("conversation has no engineRef");

    const since = await feedEventsSince(stack.feedWs, engineRef, 0);
    const events = (since.result as { events?: unknown[] }).events ?? [];

    const rss = stack.proc.pid ? stackRss(stack.proc.pid) : [];
    const byRole = (role: RssRow["role"]) =>
      rss.filter((r) => r.role === role).reduce((n, r) => n + r.rssKb, 0) /
      1024;

    const summary = {
      turns: TURNS,
      runMs,
      eventsSince: {
        bytes: since.bytes,
        events: events.length,
        ms: since.ms,
        latestSeq: (since.result as { latestSeq?: number }).latestSeq,
      },
      rssMb: {
        engine: byRole("engine"),
        harness: byRole("harness"),
        relay: byRole("relay"),
      },
    };
    console.log(`\n[replay-log] ${JSON.stringify(summary, null, 2)}`);
  } finally {
    await stack.stop();
  }
}

await main();
