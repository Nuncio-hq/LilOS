import {
  type EngineEvent,
  EngineEvent as EngineEventSchema,
  EVENT_METHOD,
} from "@lilos/contracts/engine";

/**
 * Client side of the engine protocol: JSON-RPC 2.0 over a WebSocket.
 * Transport-agnostic — the ws impl is injected so tests can run under Node
 * (`ws` package) and production under Bun (global WebSocket).
 */

export interface EngineConnection {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  onEvent(fn: (event: EngineEvent) => void): () => void;
  /** Socket dropped (not a deliberate close()). In-proc transports may omit it. */
  onClose?(fn: (reason?: string) => void): void;
  close(): void;
}

export class EngineRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "EngineRpcError";
  }
}

export const engineErrorCode = (error: unknown): number | undefined =>
  error instanceof EngineRpcError ? error.code : undefined;

/** Session does not exist on the engine (contract RPC_ERRORS.SESSION_NOT_FOUND). */
export const SESSION_NOT_FOUND = -32001;

/** Minimal browser-style socket surface both Bun's and `ws` provide. */
export interface EngineSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", fn: () => void): void;
  addEventListener(type: "message", fn: (event: { data: unknown }) => void): void;
  addEventListener(
    type: "close",
    fn: (event: { code: number; reason: string }) => void,
  ): void;
  addEventListener(type: "error", fn: (event: unknown) => void): void;
}

export type EngineSocketFactory = (url: string) => EngineSocket;

const defaultFactory: EngineSocketFactory = (url) => {
  const Impl = (
    globalThis as { WebSocket?: new (u: string) => EngineSocket }
  ).WebSocket;
  if (!Impl) {
    throw new Error("no WebSocket implementation — pass socketFactory");
  }
  return new Impl(url);
};

export interface EngineClientOptions {
  socketFactory?: EngineSocketFactory;
  requestTimeoutMs?: number;
  /**
   * A frame that is not a valid EngineEvent (unknown event type, ask kind the
   * contract doesn't carry like sudo/secret/vault, malformed payload) is
   * dropped here — the harness's refuse boundary. Never reaches the relay.
   */
  onInvalid?: (info: { reason: string; raw: string }) => void;
}

export function connectEngineWs(
  url: string,
  options: EngineClientOptions = {},
): Promise<EngineConnection> {
  const factory = options.socketFactory ?? defaultFactory;
  const timeout = options.requestTimeoutMs ?? 15_000;
  const socket = factory(url);
  const pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  const listeners = new Set<(e: EngineEvent) => void>();
  let closed = false;
  let closeFn: ((reason?: string) => void) | undefined;
  let nextId = 1;

  const failAll = (error: Error) => {
    for (const [, entry] of pending) entry.reject(error);
    pending.clear();
  };

  const ready = new Promise<EngineConnection>((resolve, reject) => {
    let settled = false;
    socket.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      resolve(connection);
    });
    socket.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      reject(new Error(`engine socket error before open (${url})`));
    });
    socket.addEventListener("close", (event) => {
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `engine socket closed during handshake: ${event.code ?? "?"}`,
          ),
        );
        return;
      }
      failAll(new Error("engine socket closed"));
      if (!closed) closeFn?.(event.reason || `code ${event.code}`);
    });
  });

  const connection: EngineConnection = {
    request<T>(method: string, params?: unknown): Promise<T> {
      if (closed || socket.readyState !== 1) {
        return Promise.reject(new Error("engine connection not open"));
      }
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(String(id));
          reject(new Error(`engine request ${method} timed out`));
        }, timeout);
        pending.set(String(id), {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v as T);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        socket.send(
          JSON.stringify({ jsonrpc: "2.0", id: String(id), method, params }),
        );
      });
    },
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onClose(fn) {
      closeFn = fn;
    },
    close() {
      closed = true;
      try {
        socket.close();
      } catch {
        // already gone
      }
      failAll(new Error("engine connection closed"));
    },
  };

  socket.addEventListener("message", (event) => {
    const text =
      typeof event.data === "string"
        ? event.data
        : event.data instanceof ArrayBuffer
          ? new TextDecoder().decode(event.data)
          : String(event.data ?? "");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      options.onInvalid?.({ reason: "unparsable frame", raw: text });
      return;
    }
    const frame = raw as {
      id?: string | number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };
    if (
      frame.id !== undefined &&
      ("result" in frame || "error" in frame)
    ) {
      const entry = pending.get(String(frame.id));
      if (!entry) return;
      pending.delete(String(frame.id));
      if (frame.error) {
        entry.reject(
          new EngineRpcError(
            frame.error.code,
            frame.error.message,
            frame.error.data,
          ),
        );
      } else {
        entry.resolve(frame.result);
      }
      return;
    }
    if (frame.method === EVENT_METHOD) {
      const parsed = EngineEventSchema.safeParse(frame.params);
      if (!parsed.success) {
        // Ask kinds the contract doesn't carry (sudo/secret/vault) fail parse
        // here and are dropped — they never leave the adapter boundary.
        options.onInvalid?.({ reason: "not a valid EngineEvent", raw: text });
        return;
      }
      for (const fn of listeners) fn(parsed.data);
    }
  });

  return ready;
}
