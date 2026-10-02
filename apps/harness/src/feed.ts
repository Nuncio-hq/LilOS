import type { EngineEvent } from "@lilos/contracts/engine";
import type { Harness } from "./harness";

/**
 * Client session feed: the app-facing read side of the engine protocol.
 * Clients speak the same JSON-RPC dialect to the harness that the harness
 * speaks to the engine, restricted to read methods (`describe`,
 * `events.since`) plus live `event` notifications the harness broadcasts.
 *
 * Read-only by design — every write path (prompts, ask answers, interrupts,
 * hires) goes through the relay + harness driver, so the feed needs no auth:
 * it only ever returns what the engine already told this machine.
 *
 * Runtime-neutral: index.ts wires it to a Bun WebSocket server.
 */

interface FeedDeps {
  describe(): unknown;
  eventsSince(sessionId: string, after: number): Promise<unknown>;
  subscribeEngineEvents(fn: (event: EngineEvent) => void): () => void;
}

const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const ENGINE_DOWN = -32020;

export function createFeedHandler(harness: Harness) {
  const deps: FeedDeps = {
    describe: () => harness.engineDescribe(),
    eventsSince: (s, a) => harness.eventsSince(s, a),
    subscribeEngineEvents: (fn) => harness.subscribeEngineEvents(fn),
  };
  return createFeed(deps);
}

/* Frames held while no peer is attached. A page reload (or the beat
 * between a socket dropping and its replacement connecting) used to eat
 * whatever the engine emitted in the gap — the event was broadcast to
 * zero peers and gone for good, because replay only covers what a client
 * asks for and no client knew a seq was missing. #400: hold them and
 * flush into the first attach; the cap only matters on a dead feed, and
 * an overflow just falls back to the client's own resync path. */
const HELD_FRAME_CAP = 1_000;

export function createFeed(deps: FeedDeps) {
  const peers = new Set<(frame: string) => void>();
  let held: string[] = [];
  const unsubscribe = deps.subscribeEngineEvents((event) => {
    const frame = JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: event,
    });
    if (peers.size === 0) {
      held.push(frame);
      if (held.length > HELD_FRAME_CAP) held.shift();
      return;
    }
    for (const send of peers) send(frame);
  });

  const attach = (send: (frame: string) => void) => {
    peers.add(send);
    for (const frame of held) send(frame);
    held = [];
  };
  const detach = (send: (frame: string) => void) => peers.delete(send);
  const close = () => {
    peers.clear();
    unsubscribe();
  };

  async function handleFrame(
    raw: string,
    send: (frame: string) => void,
  ): Promise<void> {
    let msg: {
      jsonrpc?: string;
      id?: unknown;
      method?: string;
      params?: unknown;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: PARSE_ERROR, message: "invalid JSON" },
        }),
      );
      return;
    }
    const id =
      typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;
    const reply = (result: unknown) =>
      send(JSON.stringify({ jsonrpc: "2.0", id, result }));
    const fail = (code: number, message: string) =>
      send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));

    switch (msg.method) {
      case "describe": {
        // A client may beat the engine's first attach — wait for it.
        const deadline = Date.now() + 15_000;
        let result = deps.describe();
        while (!result && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
          result = deps.describe();
        }
        if (!result) {
          fail(ENGINE_DOWN, "engine not connected");
          return;
        }
        reply(result);
        return;
      }
      case "events.since": {
        const params = (msg.params ?? {}) as {
          sessionId?: string;
          after?: number;
        };
        if (typeof params.sessionId !== "string" || !params.sessionId) {
          fail(-32602, "events.since requires {sessionId}");
          return;
        }
        try {
          reply(
            await deps.eventsSince(params.sessionId, Number(params.after ?? 0)),
          );
        } catch (error) {
          fail(
            ENGINE_DOWN,
            error instanceof Error ? error.message : "events.since failed",
          );
        }
        return;
      }
      default:
        fail(
          METHOD_NOT_FOUND,
          `feed is read-only: ${String(msg.method)} not served here`,
        );
    }
  }

  return { attach, detach, close, handleFrame };
}
