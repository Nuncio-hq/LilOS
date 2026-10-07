import { equalSecret } from "@lilos/contracts/auth";
import type { EngineEvent } from "@lilos/contracts/engine";
import type { Harness } from "./harness";

/**
 * Client session feed: the app-facing read side of the engine protocol.
 * Clients speak the same JSON-RPC dialect to the harness that the harness
 * speaks to the engine, restricted to read methods (`describe`,
 * `events.since`) plus live `event` notifications the harness broadcasts.
 *
 * Read-only by design — every write path (prompts, ask answers, interrupts,
 * hires) goes through the relay + harness driver. Read-only does NOT mean
 * unauthenticated (#564): live events carry tool output, file contents and
 * diffs, so the upgrade authenticates like `/host` — the install token,
 * plus an app-Origin check on the handshakes a browser sends.
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

export function createFeedHandler(harness: Harness, frameDelayMs = 0) {
  const deps: FeedDeps = {
    describe: () => harness.engineDescribe(),
    eventsSince: (s, a) => harness.eventsSince(s, a),
    subscribeEngineEvents: (fn) => harness.subscribeEngineEvents(fn),
  };
  return createFeed(deps, frameDelayMs);
}

/* Frames held while no peer is attached. A page reload (or the beat
 * between a socket dropping and its replacement connecting) used to eat
 * whatever the engine emitted in the gap — the event was broadcast to
 * zero peers and gone for good, because replay only covers what a client
 * asks for and no client knew a seq was missing. #400: hold them and
 * flush into the first attach; the cap only matters on a dead feed, and
 * an overflow just falls back to the client's own resync path. */
const HELD_FRAME_CAP = 1_000;

/* #659 e2e hook (`LILOS_FEED_DELAY_MS`): pace each attached peer's
   broadcast frames to one per `frameDelayMs` — the relay's answer row then
   deterministically lands before the engine stream's tail, the cross-socket
   race that rendered a reply twice. RPC replies (describe/events.since)
   bypass it: the knob slows the live stream, not the handshake. `0` sends
   immediately (production). */
function pace(
  send: (frame: string) => void,
  frameDelayMs: number,
): { send: (frame: string) => void; stop: () => void } {
  if (frameDelayMs <= 0) return { send, stop: () => {} };
  const queue: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drain = () => {
    const frame = queue.shift();
    if (frame === undefined) {
      timer = undefined;
      return;
    }
    send(frame);
    timer = setTimeout(drain, frameDelayMs);
  };
  return {
    send: (frame) => {
      queue.push(frame);
      if (timer === undefined) drain();
    },
    stop: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      queue.length = 0;
    },
  };
}

function createFeed(deps: FeedDeps, frameDelayMs = 0) {
  /* raw send -> paced broadcast sink (detach needs the same key the ws
     close handler passes). */
  const peers = new Map<(frame: string) => void, ReturnType<typeof pace>>();
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
    for (const peer of peers.values()) peer.send(frame);
  });

  const attach = (send: (frame: string) => void) => {
    const peer = pace(send, frameDelayMs);
    peers.set(send, peer);
    for (const frame of held) peer.send(frame);
    held = [];
  };
  const detach = (send: (frame: string) => void) => {
    peers.get(send)?.stop();
    peers.delete(send);
  };
  const close = () => {
    for (const peer of peers.values()) peer.stop();
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

/**
 * #564 AC-1: the feed's upgrade gate — index.ts runs it before
 * `server.upgrade`, so a refused socket never attaches and never sees a
 * held or live frame. The credential is the install token, the same one
 * `/host` and the relay hello use; a browser WebSocket can't set headers,
 * so it rides the URL as `?token=` (same carrier the surfaces viewer's
 * `/view` socket uses).
 *
 * `Origin`: a browser always sends it; script/native clients (Bun
 * `WebSocket`, `ws`, curl) don't — its absence means "not a browser", not
 * a failure. When present it must be the app's own: a loopback http(s)
 * host (the dev server, `vite preview`, and e2e pages pick their own
 * ports, so the check is scheme+host, not port), `file://`, or `null` —
 * Blink serializes a file: document's origin as `null` unless
 * `--allow-file-access-from-files` is set, so the packaged Electron
 * window can arrive as either. `null` also covers other opaque origins
 * (sandboxed iframes, data:); the token remains the credential — this
 * check only filters serialized foreign origins.
 */
export function authorizeFeedUpgrade(
  req: Request,
  token: string,
): Response | undefined {
  /* Fail closed: an empty configured credential must never authenticate.
     #611: the `?token=` credential is a secret — constant-time compare. */
  if (
    !token ||
    !equalSecret(new URL(req.url).searchParams.get("token") ?? "", token)
  ) {
    return new Response("unauthorized\n", { status: 401 });
  }
  const origin = req.headers.get("origin");
  if (origin !== null && !appOrigin(origin)) {
    return new Response("forbidden origin\n", { status: 403 });
  }
  return undefined;
}

/* A foreign page can reach 127.0.0.1 over a WebSocket — the handshake is
   not CORS-gated — but its Origin is the site's own. Loopback-only app
   origins keep such a page out even if a token ever leaked to it. */
const appOrigin = (origin: string): boolean => {
  if (origin === "null" || origin === "file://") return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "127.0.0.1" ||
      host === "::1"
    );
  } catch {
    return false;
  }
};
