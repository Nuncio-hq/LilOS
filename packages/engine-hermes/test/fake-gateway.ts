import { RpcError } from "../src/errors.js";
import type {
  GatewayCancel,
  GatewayEvent,
  GatewayLike,
  GatewayRequest,
} from "../src/gateway.js";

/**
 * In-process fake `hermes serve` gateway for tests — same shapes as the live
 * wire (verified against hermes-agent v0.21.5+2541):
 *
 *   - `session.create` returns `session_id` (stable runtime sid) +
 *     `stored_session_id` (durable ref — `rotateRef()` re-keys it, like
 *     non-in-place compression does; `session.title` exposes it as
 *     `session_key`).
 *   - `prompt.submit` records the text and returns `{status:"streaming"}`;
 *     the test then injects events via `emit()` and finishes the turn with
 *     `complete()`.
 *   - `ask()` sends a server->client request (`srq-*`) and resolves with the
 *     client's response; `cancelRequest()` withdraws it.
 */
export class FakeGateway implements GatewayLike {
  readonly serverRequests = [
    "approval",
    "clarify",
    "sudo",
    "secret",
    "vault.code",
    "vault.save_login",
    "vault.unlock_prompt",
    "preview.act",
    "preview.read",
    "terminal.read",
    "tour",
    "window.read",
    "display.install.sudo",
  ];

  lastSid = "";
  lastRef = "";
  lastPrompt?: Record<string, unknown>;
  attachedImages: Record<string, unknown>[] = [];
  closedSessions: string[] = [];
  steers: string[] = [];

  private refs = new Map<string, string>();
  private sreqId = 0;
  private sreqPending = new Map<
    string,
    (v: { result?: unknown; error?: { code: number; message: string } }) => void
  >();
  private ev = new Set<(e: GatewayEvent) => void>();
  private req = new Set<(r: GatewayRequest) => void>();
  private can = new Set<(c: GatewayCancel) => void>();
  private cls = new Set<() => void>();

  onEvent(fn: (e: GatewayEvent) => void) {
    this.ev.add(fn);
    return () => this.ev.delete(fn);
  }
  onRequest(fn: (r: GatewayRequest) => void) {
    this.req.add(fn);
    return () => this.req.delete(fn);
  }
  onCancel(fn: (c: GatewayCancel) => void) {
    this.can.add(fn);
    return () => this.can.delete(fn);
  }
  onClose(fn: () => void) {
    this.cls.add(fn);
    return () => this.cls.delete(fn);
  }
  close() {
    for (const fn of this.cls) fn();
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "session.create": {
        const sid = `sid-${this.refs.size + 1}`;
        const ref = `ref-${this.refs.size + 1}`;
        this.refs.set(sid, ref);
        this.lastSid = sid;
        this.lastRef = ref;
        return Promise.resolve({
          session_id: sid,
          stored_session_id: ref,
          message_count: 0,
          messages: [],
          info: {},
        });
      }
      case "prompt.submit":
        this.lastPrompt = p;
        return Promise.resolve({ status: "streaming", user_row_id: "u1" });
      case "session.interrupt":
        return Promise.resolve({ status: "interrupted" });
      case "session.steer":
        this.steers.push(String(p.text));
        return Promise.resolve({ status: "queued", text: p.text });
      case "session.close":
        this.closedSessions.push(String(p.session_id));
        return Promise.resolve({ closed: true });
      case "session.title":
        return Promise.resolve({
          title: "t",
          session_key: this.refs.get(String(p.session_id)) ?? "",
        });
      case "image.attach_bytes":
        this.attachedImages.push(p);
        return Promise.resolve({
          attached: true,
          count: this.attachedImages.length,
        });
      default:
        return Promise.reject(
          new RpcError(-32601, `no method ${method}`),
        );
    }
  }

  respond(id: string, body: { result?: unknown; error?: unknown }): void {
    const p = this.sreqPending.get(id);
    if (p) {
      this.sreqPending.delete(id);
      p(body as { result?: unknown; error?: { code: number; message: string } });
    }
  }

  // ── test-driving helpers ──────────────────────────────────────────────────

  emit(sid: string, type: string, payload: Record<string, unknown>) {
    for (const fn of this.ev) fn({ type, sessionId: sid, payload });
  }

  ask(
    sid: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    const id = `srq-${(++this.sreqId).toString(16)}`;
    return new Promise((resolve) => {
      this.sreqPending.set(id, resolve);
      for (const fn of this.req)
        fn({ id, method, params: { ...params, session_id: sid } });
    });
  }

  cancelRequest(id: string, method: string, reason?: string) {
    for (const fn of this.can)
      fn({ id, method, ...(reason ? { reason } : {}) });
  }

  /** Finish the open turn for a runtime sid. */
  complete(
    sid: string,
    opts: { text?: string; status?: string; error?: string } = {},
  ) {
    this.emit(sid, "message.complete", {
      text: opts.text ?? "done",
      status: opts.status ?? "complete",
      ...(opts.error ? { error: opts.error } : {}),
      usage: { input: 10, output: 5, reasoning: 1, cache_read: 2 },
    });
  }

  /** Re-key the durable ref like non-in-place compression does. */
  rotateRef(sid: string, newRef: string) {
    this.refs.set(sid, newRef);
    this.lastRef = newRef;
  }
}
