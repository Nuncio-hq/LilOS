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
      provider?: string;
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
  /**
   * model.options backing store (issue #92): two authenticated providers +
   * one unauthenticated row the engine must skip (AC-1). `capabilities`
   * mirrors `inventory.py::_apply_capabilities` — per-model {fast,
   * reasoning, can_disable_reasoning}; no supported_efforts upstream.
   */
  modelProviders: {
    slug: string;
    name: string;
    models: string[];
    capabilities?: Record<
      string,
      { fast?: boolean; reasoning?: boolean; can_disable_reasoning?: boolean }
    >;
    authenticated?: boolean;
  }[] = [
    {
      slug: "stub",
      name: "Stub",
      models: ["stub-model-a", "stub-model-b"],
      capabilities: {
        "stub-model-a": { fast: true, reasoning: true },
        "stub-model-b": { fast: false, reasoning: false },
      },
    },
    {
      slug: "devin",
      name: "Devin",
      /* An aggregator-style id that itself contains "/" — AC-8. */
      models: ["devin/claude-opus-5"],
      capabilities: {
        "devin/claude-opus-5": {
          fast: true,
          reasoning: true,
          can_disable_reasoning: false,
        },
      },
    },
    {
      slug: "ghost",
      name: "Ghost",
      models: ["ghost-model"],
      authenticated: false,
    },
  ];
  defaultModel = "stub-model-a";
  /**
   * Models that `profiles.configure` guards (real Hermes: expensive /
   * data-policy models answer `confirm_required` + `confirm_message` until
   * `confirm_expensive_model:true` is sent).
   */
  guardedModels = new Set<string>();
  /** session_id -> model set via config.set model. */
  sessionModels = new Map<string, string>();
  /** session_id -> provider / effort / fast set via config.set (#92). */
  sessionProviders = new Map<string, string>();
  sessionEfforts = new Map<string, string>();
  sessionFast = new Map<string, boolean>();
  /** config.set calls in order — {key, value, session_id, confirm_expensive_model}. */
  configSetCalls: Record<string, unknown>[] = [];
  /** `method[:key]` in arrival order — order-sensitive assertions, e.g.
      model→fast→prompt.submit for a deferred pick (#92 AC-4). */
  callLog: string[] = [];
  /** model.options calls in order (records the `refresh` flag, #92 AC-6). */
  modelOptionsCalls: Record<string, unknown>[] = [];
  /** sids currently mid-turn: config.set model answers deferred (#92 AC-4). */
  runningSids = new Set<string>();
  /** Model ids that require confirm_expensive_model on config.set. */
  confirmModels = new Set<string>();
  /** sids whose deferred model switch fails when the next prompt.submit
      applies it — Hermes emits `error {message}` and keeps the old model
      (tui_gateway session_compression._apply_pending_model_switch). */
  failDeferredSwitch = new Set<string>();
  /** When set, `config.set fast` rejects with it — transport/5001-style
      failures the engine must not swallow (#92 review). */
  fastError?: RpcError;
  /** sid -> stashed config.set model args while a turn runs (the real
      `pending_model_switch` — applied by prompt_turn at turn start). */
  private pendingSwitches = new Map<
    string,
    { model: string; provider: string; reasoning: string }
  >();
  slashCommands: string[] = [];
  /** #179: process-registry rows — {id = registry session id, pid = OS pid}. */
  processes: {
    id: string;
    command: string;
    pid: number;
    owner: string;
    startedAt: number;
    exited: boolean;
    exitCode?: number;
    reason?: string;
    tail: string;
  }[] = [];
  /** Extra provider rows appended on the NEXT model.options refresh:true
      (the "new model appeared" fixture). */
  refreshProviders: FakeGateway["modelProviders"] = [];
  refreshCount = 0;
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

  /** #288: session.resume calls in order — {session_id, profile, lazy, ...}. */
  resumeCalls: Record<string, unknown>[] = [];

  private refs = new Map<string, string>();
  /** stored_session_id -> the durable row session.resume reattaches to. */
  private storedByRef = new Map<string, { message_count: number }>();
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
    this.callLog.push(
      method === "config.set" ? `config.set:${String(p.key ?? "")}` : method,
    );
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
        this.storedByRef.set(ref, { message_count: 0 });
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
      case "session.resume": {
        this.resumeCalls.push({ ...p });
        /* The real gateway resolves a stored_session_id (or exact title) in
           the profile's state.db and mints a NEW runtime sid on the same
           stored row (tui_gateway methods_session._resume_response). */
        const key = String(p.session_id);
        const ref = this.storedByRef.has(key) ? key : this.refs.get(key);
        const stored = ref ? this.storedByRef.get(ref) : undefined;
        if (!ref || !stored)
          return Promise.reject(
            new RpcError(4040, `session not found: ${key}`),
          );
        const sid = `sid-${this.refs.size + 1}`;
        this.refs.set(sid, ref);
        this.lastSid = sid;
        return Promise.resolve({
          session_id: sid,
          stored_session_id: ref,
          message_count: stored.message_count,
          messages: [],
          messages_omitted: true,
          info: { version: "v0.21.5+test", release_date: "2026.9.24" },
        });
      }
      case "prompt.submit": {
        this.lastPrompt = p;
        const sid = String(p.session_id);
        const promptRef = this.refs.get(sid);
        const promptStored = promptRef
          ? this.storedByRef.get(promptRef)
          : undefined;
        if (promptStored) promptStored.message_count += 2; // user + assistant
        /* prompt_turn.py applies `pending_model_switch` at turn start —
           before the prompt runs. On failure the gateway emits `error` and
           the turn still runs on the previous model (#92 review). */
        const stash = this.pendingSwitches.get(sid);
        if (stash) {
          this.pendingSwitches.delete(sid);
          if (this.failDeferredSwitch.has(sid)) {
            this.emit(sid, "error", {
              message: `Could not switch model: no model ${stash.model} — see models.list`,
            });
          } else {
            this.sessionModels.set(sid, stash.model);
            if (stash.provider) this.sessionProviders.set(sid, stash.provider);
            if (stash.reasoning) this.sessionEfforts.set(sid, stash.reasoning);
          }
        }
        /* Hermes re-reports session state at turn start (a deferred pick's
           commit folds into model/provider here) — the engine mirrors it so
           `turn.started` stamps what the session ACTUALLY runs, which is
           what keeps a failed apply from stamping the dead model (#92). */
        const provider = this.sessionProviders.get(sid);
        const effort = this.sessionEfforts.get(sid);
        const fast = this.sessionFast.get(sid);
        this.emit(sid, "session.info", {
          model: this.sessionModels.get(sid) ?? this.defaultModel,
          ...(provider ? { provider } : {}),
          ...(effort ? { reasoning_effort: effort } : {}),
          ...(fast !== undefined ? { fast } : {}),
        });
        /* Mid-turn state is real: config.set model on a running sid
           answers deferred until `complete()` (#92 AC-4). */
        this.runningSids.add(sid);
        return Promise.resolve({ status: "streaming", user_row_id: "u1" });
      }
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
      /* #179: the process registry behind background terminal calls —
         `tests` script rows via `pushProcess`, `killProcess` flips them to
         exited like registry.kill_process does. */
      case "process.list": {
        return Promise.resolve({
          processes: this.processes
            .filter((pr) => pr.owner === String(p.session_id))
            .map((pr) => ({
              session_id: pr.id,
              command: pr.command,
              pid: pr.pid,
              owner_task_id: "task-1",
              started_at: new Date(pr.startedAt).toISOString().slice(0, 19),
              uptime_seconds: Math.round((Date.now() - pr.startedAt) / 1000),
              status: pr.exited ? "exited" : "running",
              output_preview: pr.tail.slice(-200),
              output_tail: pr.tail,
              ...(pr.exited
                ? { exit_code: pr.exitCode, completion_reason: pr.reason }
                : {}),
            })),
        });
      }
      case "process.kill": {
        const proc = this.processes.find(
          (pr) => pr.id === String(p.process_id),
        );
        if (!proc)
          return Promise.reject(
            new RpcError(4044, `no such process: ${String(p.process_id)}`),
          );
        if (proc.exited)
          return Promise.resolve({
            status: "already_exited",
            session_id: proc.id,
            exit_code: proc.exitCode,
            completion_reason: proc.reason,
          });
        proc.exited = true;
        proc.exitCode = -15;
        proc.reason = "killed";
        return Promise.resolve({
          status: "killed",
          session_id: proc.id,
          exit_code: -15,
          completion_reason: "killed",
        });
      }
      case "session.title":
        /* The gateway echoes the just-set title back (tui_gateway/methods
           _session_title returns the stored row); tests need the echo to be
           the requested value, not a canned one. */
        return Promise.resolve({
          title: String(p.title ?? "t"),
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
          model: { provider: pr.provider ?? "stub", default: pr.model ?? "" },
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
          ...(typeof p.provider === "string" ? { provider: p.provider } : {}),
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
      case "profiles.configure": {
        // Mirrors methods_profiles.py: soul/description write straight in;
        // the model section pins `model.{provider,default}` and needs BOTH
        // model and provider — without both it is silently skipped.
        const pr = this.profiles.get(String(p.name));
        if (!pr)
          return Promise.reject(
            new RpcError(-32602, `no profile ${String(p.name)}`),
          );
        const applied: Record<string, boolean> = {};
        if (typeof p.soul === "string") {
          pr.soul = p.soul;
          applied.soul = true;
        }
        if (typeof p.description === "string") {
          pr.description = p.description;
          applied.description = true;
        }
        const wantsModel =
          typeof p.model === "string" && typeof p.provider === "string";
        if (wantsModel && this.guardedModels.has(String(p.model))) {
          if (p.confirm_expensive_model === true) {
            pr.model = String(p.model);
            applied.model = true;
            return Promise.resolve({ ok: true, name: pr.name, applied });
          }
          return Promise.resolve({
            ok: true,
            name: pr.name,
            applied,
            confirm_required: true,
            confirm_message: `model ${String(p.model)} is expensive — confirm to pin it`,
          });
        }
        if (wantsModel) {
          pr.model = String(p.model);
          applied.model = true;
        }
        return Promise.resolve({ ok: true, name: pr.name, applied });
      }
      case "model.options":
        this.modelOptionsCalls.push({ ...p });
        if (p.refresh === true) {
          this.refreshCount++;
          if (this.refreshProviders.length)
            this.modelProviders = [
              ...this.modelProviders,
              ...this.refreshProviders.splice(0),
            ];
        }
        return Promise.resolve({
          providers: this.modelProviders,
          model: this.defaultModel,
          provider: this.modelProviders[0]?.slug ?? "",
        });
      case "config.set": {
        /* Mirrors tui_gateway/methods_config_set.py: `model` parses
           `<id> --provider <slug> --reasoning <level>`; running sessions
           answer {deferred:true}; a guarded model answers
           confirm_required until confirm_expensive_model. */
        const key = String(p.key ?? "");
        const value = String(p.value ?? "");
        const sid = String(p.session_id ?? "");
        this.configSetCalls.push({
          key,
          value,
          session_id: sid,
          confirm_expensive_model: p.confirm_expensive_model === true,
        });
        if (key === "model") {
          let modelId = "";
          let provider = "";
          let reasoning = "";
          const tokens = value.split(/\s+/).filter(Boolean);
          for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            if (t === "--provider") provider = tokens[++i] ?? "";
            else if (t === "--reasoning") reasoning = tokens[++i] ?? "";
            else if (!t.startsWith("--") && !modelId) modelId = t;
          }
          if (!modelId)
            return Promise.reject(new RpcError(4002, "model value required"));
          if (
            this.confirmModels.has(modelId) &&
            p.confirm_expensive_model !== true
          )
            return Promise.resolve({
              key,
              value: modelId,
              confirm_required: true,
              confirm_message: `${modelId} is a paid model — confirm?`,
              scope: "session",
            });
          if (this.runningSids.has(sid)) {
            /* The stash, not a live write: `_stash_pending_model_switch`
               parks the parsed args; the session's effective model changes
               only when the next turn applies it (#92 review). */
            this.pendingSwitches.set(sid, {
              model: modelId,
              provider,
              reasoning,
            });
            return Promise.resolve({
              key,
              value: modelId,
              scope: "session",
              deferred: true,
            });
          }
          this.sessionModels.set(sid, modelId);
          if (provider) this.sessionProviders.set(sid, provider);
          if (reasoning) this.sessionEfforts.set(sid, reasoning);
          return Promise.resolve({ key, value: modelId, scope: "session" });
        }
        if (key === "fast") {
          if (this.fastError) return Promise.reject(this.fastError);
          const v =
            value === "on" || value === "fast"
              ? "fast"
              : value === "off" || value === "normal"
                ? "normal"
                : undefined;
          if (!v)
            return Promise.reject(
              new RpcError(4002, `unknown fast mode: ${value}`),
            );
          /* `_set_fast` has no running check — it mutates the live session
             mid-turn and 4002s only for an unknown mode or a model whose
             catalog caps say no fast tier (#92 review). */
          const cur = this.sessionModels.get(sid) ?? this.defaultModel;
          const caps = this.modelProviders
            .flatMap((pr) => Object.entries(pr.capabilities ?? {}))
            .find(([id]) => id === cur)?.[1];
          if (caps && caps.fast === false)
            return Promise.reject(
              new RpcError(4002, "fast mode is not available for this model"),
            );
          this.sessionFast.set(sid, v === "fast");
          return Promise.resolve({ key, value: v, scope: "session" });
        }
        if (key === "reasoning") {
          this.sessionEfforts.set(sid, value);
          return Promise.resolve({ key, value, scope: "session" });
        }
        return Promise.resolve({ key, value });
      }
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
    this.runningSids.delete(sid);
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

  /** #179: register a process-registry row owned by a runtime sid. */
  pushProcess(
    sid: string,
    over: Partial<FakeGateway["processes"][number]> & { command: string },
  ): FakeGateway["processes"][number] {
    const row = {
      id: `proc-${this.processes.length + 1}`,
      pid: 4200 + this.processes.length,
      owner: sid,
      startedAt: Date.now(),
      exited: false,
      tail: "",
      ...over,
    };
    this.processes.push(row);
    return row;
  }
}
