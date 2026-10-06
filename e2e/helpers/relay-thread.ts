/**
 * Grow a DM thread through the relay's own RPC instead of the composer
 * (#574): `conversations.open` mints the root, `messages.post` adds each
 * later turn, and every send waits its `turn.completed` — the same calls
 * the composer makes, minus the per-turn browser round trip. Specs that
 * only need a long settled thread (ac-512's 60 turns, ac-431's 12) spend
 * seconds here instead of ~a minute typing in the page.
 *
 * Lifted from `e2e/bench/replay-log.ts`; the socket is the `ws` package
 * because Playwright spec files run under Node, where no global WebSocket
 * is guaranteed (the client's `socketFactory` seam exists for exactly
 * this — see packages/client-runtime/src/socket.ts).
 */

import WebSocket from "ws";
import { RelayClient } from "../../packages/client-runtime/src/index";
import type { EngineEvent } from "../../packages/contracts/src/engine/index";
import type { Stack } from "./stack";

export interface GrownThread {
  employeeId: string;
  channelId: string;
  conversationId: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Post `prompts` as sequential turns on `employeeName`'s DM (default the
 * seeded "Default" employee — the one the specs' dm buttons open).
 * `prompts[0]` becomes the thread root; each send waits for its own
 * turn to complete so the thread is fully settled when this returns.
 */
export async function growDmThread(
  stack: Stack,
  prompts: readonly string[],
  opts: { employeeName?: RegExp } = {},
): Promise<GrownThread> {
  if (prompts.length === 0) throw new Error("growDmThread needs ≥1 prompt");
  const relay = new RelayClient({
    url: stack.relayWs,
    token: stack.relayToken,
    socketFactory: (url) => new WebSocket(url),
  });
  try {
    /* engine.event frames reach channel subscribers only — arm the
       completion waiter before subscribing. */
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
    for (let i = 0; i < 300 && !relay.directoryReady.get(); i++) {
      await sleep(100);
    }
    if (!relay.directoryReady.get()) {
      throw new Error("relay directory never loaded");
    }

    const employee = relay.employees
      .get()
      .find((e) => (opts.employeeName ?? /^default$/i).test(e.name));
    if (!employee) throw new Error("no matching employee in the seeded stack");
    /* `channels.openDm` is idempotent — the same call the page makes when
       the DM route finds no channel. */
    const { channel } = await relay.request<{
      channel: { id: string };
    }>("channels.openDm", { employeeId: employee.id });
    await relay.request("channel.subscribe", { channelId: channel.id });

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

    let conversationId = "";
    for (const text of prompts) {
      if (!conversationId) {
        const res = await relay.request<{
          conversation: { id: string };
        }>("conversations.open", {
          channelId: channel.id,
          authorId: "user",
          text,
        });
        conversationId = res.conversation.id;
      } else {
        await relay.request("messages.post", {
          channelId: channel.id,
          conversationId,
          authorId: "user",
          authorKind: "user",
          text,
        });
      }
      await waitTurn(conversationId);
    }
    return { employeeId: employee.id, channelId: channel.id, conversationId };
  } finally {
    relay.close();
  }
}
