import type { EngineEvent, JsonRpcId } from "@lilos/contracts/engine";
import type { EngineConnection } from "./harness.js";

/**
 * WebSocket transport for the conformance suite. Uses the runtime's global
 * WebSocket (Bun, Node >= 21) — no dependency. Client->server frames are
 * requests; server->client frames are `"event"` notifications or responses.
 */
export function connectWs(
  url: string,
  timeout = 10_000,
): Promise<EngineConnection> {
  const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS)
    return Promise.reject(
      new Error("global WebSocket is not available in this runtime"),
    );
  return new Promise((resolve, reject) => {
    const ws = new WS(url);
    let nextId = 0;
    const pending = new Map<
      JsonRpcId,
      { resolve: (v: unknown) => void; reject: (e: unknown) => void }
    >();
    const listeners = new Set<(e: EngineEvent) => void>();
    const to = setTimeout(
      () => reject(new Error(`ws connect timeout: ${url}`)),
      timeout,
    );
    ws.onopen = () => {
      clearTimeout(to);
      resolve({
        request(method, params = {}) {
          const id = `ws-${++nextId}`;
          const p = new Promise<unknown>((res, rej) =>
            pending.set(id, { resolve: res, reject: rej }),
          );
          p.catch(() => {}); // abandoned prompts must not trip unhandled rejection
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
          return p;
        },
        onEvent(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        close() {
          ws.close();
        },
      });
    };
    ws.onerror = () => reject(new Error(`ws error: ${url}`));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as {
        id?: JsonRpcId;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { code: number; message: string; data?: unknown };
      };
      if (m.method === "event") {
        for (const fn of listeners) fn(m.params as EngineEvent);
        return;
      }
      if (m.id !== undefined) {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.error) {
          const e = new Error(m.error.message) as Error & {
            code: number;
            data?: unknown;
          };
          e.code = m.error.code;
          e.data = m.error.data;
          p.reject(e);
        } else {
          p.resolve(m.result);
        }
      }
    };
  });
}
