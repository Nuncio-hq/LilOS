import {
  type EngineEvent,
  EVENT_METHOD,
  RPC_ERRORS,
} from "@lilos/contracts/engine";
import type { AcpEngine } from "./engine.js";
import { RpcError } from "./errors.js";

/**
 * In-memory transport, same JSON-RPC frame semantics as the wire — requests
 * are serialized through `handleJsonRpc`, so this exercises the same code
 * path a socket entry does. The shape is the conformance suite's
 * `EngineConnection`.
 */
export interface AcpEngineConnection {
  request(method: string, params?: unknown): Promise<unknown>;
  onEvent(fn: (e: EngineEvent) => void): () => void;
  close(): void;
}

export function handleJsonRpc(
  engine: AcpEngine,
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

export function connectAcp(engine: AcpEngine): AcpEngineConnection {
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
      error?: { code: number; message: string };
    };
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) {
      p.reject(new RpcError(m.error.code, m.error.message));
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
      void engine.close();
    },
  };
}

export const acpEventFrame = (e: EngineEvent) =>
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
