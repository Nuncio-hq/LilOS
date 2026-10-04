import { RPC_ERRORS } from "@lilos/contracts/engine";
import { RpcError } from "./errors.js";

/**
 * Hermes `hermes serve` gateway client — speaks the `hermes-gateway-v1`
 * WebSocket protocol (`tui_gateway/web_server_chat.py`,
 * `tui_gateway/server_requests.py` in the reference repo):
 *
 *   ws://HOST:PORT/api/ws?token=TOKEN     subprotocol: hermes-gateway-v1
 *
 * Frame shapes (live-verified against hermes-agent v0.21.5+):
 * - events:   {"jsonrpc":"2.0","method":"event","params":{"type","session_id","payload"}}
 * - replies:  {"id":"c<n>","result"|"error": ...}
 * - server->client requests: {"id":"srq-<hex>","method":"approval"|"clarify"|...,"params":{...}}
 *   answered with {"id":"srq-...","result"|"error": ...}
 * - withdrawal of an open server request: {"method":"request.cancel","params":{"id","method","reason"}}
 *
 * The connect handshake is `client.capabilities {server_requests:true}` —
 * without it the server never sends approval/clarify requests.
 */

export interface GatewayEvent {
  type: string;
  sessionId: string;
  payload: Record<string, unknown>;
}

export interface GatewayRequest {
  /** `srq-...` wire id — echoed verbatim in the response frame. */
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface GatewayCancel {
  id: string;
  method: string;
  reason?: string;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Public surface of the gateway — also implemented by the test fake. */
export interface GatewayLike {
  readonly serverRequests: readonly string[];
  request(
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ): Promise<unknown>;
  respond(id: string, body: { result?: unknown; error?: unknown }): void;
  onEvent(fn: (e: GatewayEvent) => void): () => void;
  onRequest(fn: (r: GatewayRequest) => void): () => void;
  onCancel(fn: (c: GatewayCancel) => void): () => void;
  onClose(fn: () => void): () => void;
  close(): void;
}

export class HermesGateway implements GatewayLike {
  private nextId = 0;
  private pending = new Map<string, Pending>();
  private eventListeners = new Set<(e: GatewayEvent) => void>();
  private requestListeners = new Set<(r: GatewayRequest) => void>();
  private cancelListeners = new Set<(c: GatewayCancel) => void>();
  private closeListeners = new Set<() => void>();

  private constructor(private ws: WebSocket) {}

  /** Advertised server->client request methods from the handshake. */
  serverRequests: readonly string[] = [];

  static connect(
    url: string,
    { timeout = 10_000 }: { timeout?: number } = {},
  ): Promise<HermesGateway> {
    const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WS)
      return Promise.reject(
        new Error("global WebSocket is not available in this runtime"),
      );
    return new Promise((resolve, reject) => {
      // No subprotocol: the server only echoes one in ticket-auth mode; a
      // requested-but-unacknowledged subprotocol makes strict clients abort.
      const ws = new WS(url);
      const gw = new HermesGateway(ws);
      const to = setTimeout(() => {
        ws.close();
        reject(new Error(`hermes gateway connect timeout: ${url}`));
      }, timeout);
      ws.onmessage = (ev) => gw.onFrame(String(ev.data));
      ws.onerror = () => {
        clearTimeout(to);
        reject(new Error(`hermes gateway socket error: ${url}`));
      };
      ws.onclose = () => gw.didClose();
      ws.onopen = () => {
        // First frame the server sends is a `gateway.ready` event; the
        // capabilities call is answered independently of it.
        gw.request("client.capabilities", { server_requests: true })
          .then((r) => {
            const reqs = (r as { server_requests?: unknown }).server_requests;
            gw.serverRequests = Array.isArray(reqs)
              ? reqs.filter((x): x is string => typeof x === "string")
              : [];
            clearTimeout(to);
            resolve(gw);
          })
          .catch((e) => {
            clearTimeout(to);
            ws.close();
            reject(e instanceof Error ? e : new Error(String(e)));
          });
      };
    });
  }

  /**
   * JSON-RPC request over the gateway socket (client->server `c<n>` ids).
   * `timeoutMs` arms a per-call deadline: without it a request written into
   * a silently-dead socket never settled (#482 — the 15 s hangs came from
   * the caller's own timeout, not ours). 0/undefined = no deadline.
   */
  request(
    method: string,
    params: unknown = {},
    timeoutMs?: number,
  ): Promise<unknown> {
    const id = `c${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const p: Pending = { resolve, reject };
      if (timeoutMs && timeoutMs > 0) {
        p.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(
            new RpcError(
              RPC_ERRORS.INTERNAL_ERROR,
              `engine request ${method} timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }
      this.pending.set(id, p);
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        /* A send on a closed socket throws on some runtimes — settle the
           call right now rather than leaving it parked in `pending`. */
        if (p.timer) clearTimeout(p.timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  /** Answer a server->client `srq-*` request (result or JSON-RPC error). */
  respond(id: string, body: { result?: unknown; error?: unknown }): void {
    this.send({ jsonrpc: "2.0", id, ...body });
  }

  onEvent(fn: (e: GatewayEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }
  onRequest(fn: (r: GatewayRequest) => void): () => void {
    this.requestListeners.add(fn);
    return () => this.requestListeners.delete(fn);
  }
  onCancel(fn: (c: GatewayCancel) => void): () => void {
    this.cancelListeners.add(fn);
    return () => this.cancelListeners.delete(fn);
  }
  onClose(fn: () => void): () => void {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
    this.didClose();
  }

  private didClose(): void {
    /* #482: requests parked on a socket that just died fail typed
       BACKEND_DOWN — the caller sees `engine_unavailable` (retryable) and
       the relay maps it, instead of a generic engine_error. */
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new RpcError(RPC_ERRORS.BACKEND_DOWN, "gateway closed"));
    }
    this.pending.clear();
    for (const fn of this.closeListeners) fn();
  }

  private send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  private onFrame(text: string): void {
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      return; // unparseable gateway frame — drop, never crash the loop
    }
    if (typeof m !== "object" || m === null) return;
    const f = m as Record<string, unknown>;

    // Server->client request (has a method AND an srq-* id).
    if (
      typeof f.method === "string" &&
      typeof f.id === "string" &&
      f.id.startsWith("srq-")
    ) {
      const params =
        typeof f.params === "object" && f.params !== null
          ? (f.params as Record<string, unknown>)
          : {};
      for (const fn of this.requestListeners)
        fn({ id: f.id, method: f.method, params });
      return;
    }

    // Notification: event or request.cancel.
    if (typeof f.method === "string" && f.id === undefined) {
      if (f.method === "event") {
        const p =
          typeof f.params === "object" && f.params !== null
            ? (f.params as Record<string, unknown>)
            : {};
        if (typeof p.type === "string") {
          const event: GatewayEvent = {
            type: p.type,
            sessionId: typeof p.session_id === "string" ? p.session_id : "",
            payload:
              typeof p.payload === "object" && p.payload !== null
                ? (p.payload as Record<string, unknown>)
                : {},
          };
          for (const fn of this.eventListeners) fn(event);
        }
        return;
      }
      if (f.method === "request.cancel") {
        const p =
          typeof f.params === "object" && f.params !== null
            ? (f.params as Record<string, unknown>)
            : {};
        if (typeof p.id === "string") {
          const cancel: GatewayCancel = {
            id: p.id,
            method: typeof p.method === "string" ? p.method : "",
            ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
          };
          for (const fn of this.cancelListeners) fn(cancel);
        }
        return;
      }
      return; // unknown notification
    }

    // Response to a client request.
    if ((typeof f.id === "string" || typeof f.id === "number") && "id" in f) {
      const p = this.pending.get(f.id as string);
      if (!p) return;
      this.pending.delete(f.id as string);
      if (p.timer) clearTimeout(p.timer);
      if (f.error) {
        const err = f.error as { code?: unknown; message?: unknown };
        p.reject(
          new RpcError(
            typeof err.code === "number" ? err.code : RPC_ERRORS.INTERNAL_ERROR,
            typeof err.message === "string" ? err.message : "gateway error",
            f.error,
          ),
        );
      } else {
        p.resolve(f.result);
      }
    }
  }
}
