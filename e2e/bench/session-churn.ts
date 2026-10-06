/**
 * Issue #573 AC-2 — session-churn memory soak.
 *
 * Boots the dev stack (relay + harness + vite via e2e/helpers/stack.ts —
 * vite is unused, the bench speaks relay WS), then churns sessions through
 * the REAL stop path: for each iteration it hires an employee, opens the
 * DM, runs N turns through conversations.open + messages.post (the same
 * calls the composer makes), then removes the employee — the relay's
 * `channel.removed` broadcast is what makes the harness call
 * `session.stop` (apps/harness/src/harness/relay-events.ts).
 *
 * After each removed employee it samples the stack's process-group RSS,
 * split relay / harness / engine. Before #573 the engine kept every
 * stopped Session (event log included) in its sessions map: engine RSS
 * climbed ~4.5 MB per churned session. After the fix the engine line
 * should stay flat across iterations.
 *
 *   bun e2e/bench/session-churn.ts                    # 10 sessions x 60 turns
 *   bun e2e/bench/session-churn.ts --sessions 10 --turns 300
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
const SESSIONS = Math.max(1, Number(arg("sessions", "10")) || 10);
const TURNS = Math.max(1, Number(arg("turns", "60")) || 60);
const PROMPT = "md: blocks";
const USER_ID = "user";
const TICK = arg("tick", "2");
/** Settle window after employees.remove so channel.removed -> session.stop
    lands before the RSS sample. */
const SETTLE_MS = Math.max(0, Number(arg("settle", "400")) || 400);

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

const mb = (kb: number) => Math.round((kb / 1024) * 10) / 10;

async function main() {
  const ports = await pickPorts();
  console.log(
    `[churn] booting stack relay=${ports.relay} feed=${ports.feed} — ${SESSIONS} sessions x ${TURNS} turns`,
  );
  const stack = await bootStack("churn", ports, {
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

    const groupPid = stack.proc.pid;
    const sample = () => {
      const rss = groupPid ? stackRss(groupPid) : [];
      const byRole = (role: RssRow["role"]) =>
        mb(rss.filter((r) => r.role === role).reduce((n, r) => n + r.rssKb, 0));
      return {
        engine: byRole("engine"),
        harness: byRole("harness"),
        relay: byRole("relay"),
      };
    };

    const rows: {
      session: number;
      engine: number;
      harness: number;
      relay: number;
    }[] = [];
    const started = Date.now();
    for (let i = 1; i <= SESSIONS; i++) {
      const emp = await relay.request<{ employee: { id: string } }>(
        "employees.create",
        { name: `Churn ${i}`, profile: "builder" },
      );
      const dm = await relay.request<{ channel: { id: string } }>(
        "channels.openDm",
        { employeeId: emp.employee.id },
      );
      const channelId = dm.channel.id;
      await relay.request("channel.subscribe", { channelId });

      let convId: string | undefined;
      for (let t = 1; t <= TURNS; t++) {
        if (!convId) {
          const res = await relay.request<{
            conversation: { id: string };
          }>("conversations.open", {
            channelId,
            authorId: USER_ID,
            text: PROMPT,
          });
          convId = res.conversation.id;
        } else {
          await relay.request("messages.post", {
            channelId,
            conversationId: convId,
            authorId: USER_ID,
            authorKind: "user",
            text: PROMPT,
          });
        }
        await waitTurn(convId);
      }

      /* The production forget path: relay deletes the DM channel and
         broadcasts channel.removed; the harness answers session.stop. */
      await relay.request("employees.remove", { id: emp.employee.id });
      await sleep(SETTLE_MS);

      const s = sample();
      rows.push({ session: i, ...s });
      console.log(
        `[churn] after session ${i}/${SESSIONS} (${TURNS} turns): engine=${s.engine}MB relay=${s.relay}MB harness=${s.harness}MB`,
      );
    }
    const runMs = Date.now() - started;

    const first = rows[0];
    const last = rows[rows.length - 1];
    const summary = {
      sessions: SESSIONS,
      turnsPerSession: TURNS,
      runMs,
      first,
      last,
      delta: {
        engine: Math.round((last.engine - first.engine) * 10) / 10,
        harness: Math.round((last.harness - first.harness) * 10) / 10,
        relay: Math.round((last.relay - first.relay) * 10) / 10,
      },
      perSession: rows,
    };
    console.log(`\n[churn] ${JSON.stringify(summary, null, 2)}`);
    relay.close();
  } finally {
    await stack.stop();
  }
}

await main();
