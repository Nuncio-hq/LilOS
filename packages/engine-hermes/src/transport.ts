import {
  type EngineEvent,
  EVENT_METHOD,
  RPC_ERRORS,
} from "@lilos/contracts/engine";
import type { HermesEngine } from "./engine.js";
import { RpcError } from "./errors.js";

/**
 * Transport glue — the same frame semantics as engine-fake's `transport.ts`
 * (thin on purpose: any carrier of JSON text frames speaks the protocol).
 * Kept local because engine packages depend only on `contracts`.
 */

/** Process one inbound text frame; null for notifications. */
export function handleJsonRpc(
  engine: HermesEngine,
  frame: string,
): Promise<string | null> {
  let msg: unknown;
  try {
    msg = JSON.parse(frame);
  } catch {
    return errText(null, RPC_ERRORS.PARSE_ERROR, "parse error");
  }
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
    return errText(
      null,
      RPC_ERRORS.INVALID_REQUEST,
      "expected a single request object",
    );
  }
  const { id, method, params } = msg as {
    id?: unknown;
    method?: unknown;
    params?: unknown;
  };
  if (typeof method !== "string")
    return errText(null, RPC_ERRORS.INVALID_REQUEST, "missing method");
  if (id === undefined) return Promise.resolve(null);
  if (
    typeof id !== "string" &&
    !(typeof id === "number" && Number.isInteger(id))
  ) {
    return errText(
      null,
      RPC_ERRORS.INVALID_REQUEST,
      "id must be a string or integer",
    );
  }
  return engine
    .dispatch(method, params ?? {})
    .then((result) => JSON.stringify({ jsonrpc: "2.0", id, result }))
    .catch((e: unknown) =>
      e instanceof RpcError
        ? errText(id, e.code, e.message, e.data)
        : errText(
            id,
            RPC_ERRORS.INTERNAL_ERROR,
            e instanceof Error ? e.message : "internal error",
          ),
    );
}

/** A request/response channel plus the push stream, as the suite sees it. */
export interface HermesConnection {
  request(method: string, params?: unknown): Promise<unknown>;
  onEvent(fn: (e: EngineEvent) => void): () => void;
  close(): void;
}

/** In-memory transport — same serialization path as the WebSocket entry. */
export function connectInMemory(engine: HermesEngine): HermesConnection {
  let nextId = 0;
  const pending = new Map<
    string | number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  const send = async (frame: string) => {
    const res = await handleJsonRpc(engine, frame);
    if (res === null) return;
    const m = JSON.parse(res) as {
      id: string | number;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) {
      p.reject(new RpcError(m.error.code, m.error.message, m.error.data));
    } else {
      p.resolve(m.result);
    }
  };
  return {
    request(method, params = {}) {
      const id = `mem-${++nextId}`;
      const p = new Promise<unknown>((resolve, reject) =>
        pending.set(id, { resolve, reject }),
      );
      p.catch(() => {});
      void send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      return p;
    },
    onEvent: (fn) => engine.onEvent(fn),
    close() {
      for (const [, p] of pending)
        p.reject(new RpcError(RPC_ERRORS.INTERNAL_ERROR, "connection closed"));
      pending.clear();
    },
  };
}

export const eventFrame = (e: EngineEvent) =>
  JSON.stringify({ jsonrpc: "2.0", method: EVENT_METHOD, params: e });

function errText(
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
): Promise<string> {
  const e: { code: number; message: string; data?: unknown } = {
    code,
    message,
  };
  if (data !== undefined) e.data = data;
  return Promise.resolve(
    JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: e }),
  );
}
