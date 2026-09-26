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
  /** profiles.* backing store — a LilOS agent IS a hermes profile. */
  profiles = new Map<
    string,
    {
      name: string;
      description?: string;
      soul?: string;
      model?: string;
      skill_count?: number;
    }
  >([
    [
      "builder",
      {
        name: "builder",
        description: "seed builder",
        soul: "You are Builder.",
        model: "stub-model-a",
        skill_count: 3,
      },
    ],
  ]);
  /** model.options backing store. */
  modelProviders: { slug: string; name: string; models: string[] }[] = [
    { slug: "stub", name: "Stub", models: ["stub-model-a", "stub-model-b"] },
  ];
  defaultModel = "stub-model-a";
  /** session_id -> model set via slash.exec /model. */
  sessionModels = new Map<string, string>();
  slashCommands: string[] = [];
  /** When set, session.steer resolves with this status instead of "queued". */
  steerStatus: "queued" | "rejected" = "queued";
  /** When set, session.steer rejects with this error code (e.g. 4010 build window). */
  steerError?: number;
  /**
   * #50 AC-1 — `session.create` params this gateway's contract forbids
   * (older Hermes builds: Params models are `extra="forbid"` and answer the
   * JSON-RPC `4000` extra_forbidden error). Every call is recorded in
   * `createCalls`; `createRejects` counts the refused attempts.
   */
  forbiddenCreateFields = new Set<string>();
  createCalls: Record<string, unknown>[] = [];
  createRejects = 0;
  /**
   * #50 AC-3 — when true, `slash.exec /model <id>` answers success for ANY
   * id, mirroring real Hermes (the switch is lazy: it only fails at the next
   * prompt). Lets tests prove the engine pre-validates via `model.options`.
   */
  slashAlwaysOk = false;

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
        this.createCalls.push({ ...p });
        for (const field of this.forbiddenCreateFields) {
          if (field in p) {
            this.createRejects++;
            // Same wire shape as tui_gateway/contracts/registry.py
            // validate_params' extra_forbidden rejection.
            return Promise.reject(
              new RpcError(
                4000,
                `invalid params for session.create: ${field}: Extra inputs are not permitted — the client and the Hermes backend are out of sync (different versions); run \`hermes update\` and restart both`,
              ),
            );
          }
        }
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
          // SessionLiveInfo — the build's own advertised version.
          info: { version: "v0.21.5+test", release_date: "2026.9.24" },
        });
      }
      case "prompt.submit":
        this.lastPrompt = p;
        return Promise.resolve({ status: "streaming", user_row_id: "u1" });
      case "session.interrupt":
        return Promise.resolve({ status: "interrupted" });
      case "session.steer":
        if (this.steerError)
          return Promise.reject(
            new RpcError(this.steerError, "agent not built yet"),
          );
        if (this.steerStatus === "rejected")
          return Promise.resolve({ status: "rejected" });
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
      case "profiles.list":
        return Promise.resolve({
          profiles: [...this.profiles.values()].map((pr) => ({
            name: pr.name,
            path: `/profiles/${pr.name}`,
            description: pr.description ?? "",
            model: pr.model ?? null,
            skill_count: pr.skill_count ?? 0,
            previous_names: [],
          })),
          bot_mode_protocol: true,
        });
      case "profiles.describe": {
        const pr = this.profiles.get(String(p.name));
        if (!pr)
          return Promise.reject(
            new RpcError(-32602, `no profile ${String(p.name)}`),
          );
        return Promise.resolve({
          name: pr.name,
          description: pr.description ?? "",
          soul: pr.soul ?? "",
          model: { provider: "stub", default: pr.model ?? "" },
          skills: Array.from({ length: pr.skill_count ?? 0 }, (_, i) => ({
            name: `skill-${i}`,
          })),
          toolsets: [],
          mcp_servers: [],
        });
      }
      case "profiles.create": {
        const name = String(p.name ?? "");
        if (this.profiles.has(name))
          return Promise.reject(new RpcError(-32602, `profile ${name} exists`));
        this.profiles.set(name, {
          name,
          ...(typeof p.description === "string"
            ? { description: p.description }
            : {}),
          ...(typeof p.soul === "string" ? { soul: p.soul } : {}),
          ...(typeof p.model === "string" ? { model: p.model } : {}),
          skill_count: 0,
        });
        return Promise.resolve({
          ok: true,
          name,
          path: `/profiles/${name}`,
          soul_written: typeof p.soul === "string",
          model_set: typeof p.model === "string",
          mirrored: { credentials: false, env: false },
        });
      }
      case "model.options":
        return Promise.resolve({
          providers: this.modelProviders,
          model: this.defaultModel,
          provider: this.modelProviders[0]?.slug ?? "",
        });
      case "slash.exec": {
        const command = String(p.command ?? "");
        this.slashCommands.push(command);
        const m = /^\/model\s+(\S+)/.exec(command);
        if (m) {
          const want = m[1].includes("/")
            ? m[1].slice(m[1].indexOf("/") + 1)
            : m[1];
          if (this.slashAlwaysOk) {
            this.sessionModels.set(String(p.session_id), want);
            return Promise.resolve({ output: `✓ Switched model to ${m[1]}` });
          }
          const known = this.modelProviders.some((pr) =>
            pr.models.includes(want),
          );
          if (!known)
            return Promise.resolve({ output: `✗ Unknown model: ${want}` });
          this.sessionModels.set(String(p.session_id), want);
          return Promise.resolve({ output: `Switched model to ${want}` });
        }
        return Promise.resolve({ output: "" });
      }
      default:
        return Promise.reject(new RpcError(-32601, `no method ${method}`));
    }
  }

  respond(id: string, body: { result?: unknown; error?: unknown }): void {
    const p = this.sreqPending.get(id);
    if (p) {
      this.sreqPending.delete(id);
      p(
        body as { result?: unknown; error?: { code: number; message: string } },
      );
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
