import {
  type ApprovalOutcome,
  type EngineEvent,
  type EngineEventType,
  type EngineRequest,
  type JobStatus,
  type McpServer,
  RPC_ERRORS,
  type SessionState,
  type Usage,
} from "@lilos/contracts/engine";
import { RpcError } from "./errors.js";

export type DriverKind = "ws" | "acp";

/** #179: an engine-owned background process row (jobs.* surface). */
export interface HermesJob {
  jobId: string;
  command: string;
  status: JobStatus;
  /** ms epoch — the row's started clock (process.list `started_at` wins). */
  startedAt: number;
  pid?: number;
  /** ms epoch the job stopped running — uptime freezes at it. */
  endedAt?: number;
  exitCode?: number;
  tail: string;
  url?: string;
  /** job.started went out — later state moves land as job.output/job.exited. */
  startedEmitted: boolean;
  /** Tail length already sent in a job.output (dirty check for the flush). */
  flushedLen: number;
}

export interface Turn {
  turnId: string;
  phase: "reasoning" | "tools" | "text" | "waiting";
  /** #180: ACP `plan` updates bump this per snapshot so versions increase. */
  plan?: { planId: string; version: number };
  resolve: (r: { turnId: string; stopReason: string; usage?: Usage }) => void;
  reject: (e: unknown) => void;
}

/**
 * One open engine-side request. `wireId` is the id the backend answers on
 * (the `srq-*` id for the WS gateway); a batch clarify maps each qid to its
 * own `requestId` sharing one `group` so the wire resolves once all parts
 * are answered.
 */
export interface PendingAsk {
  requestId: string;
  turnId: string;
  request: EngineRequest;
  seq: number;
  wireId: string;
  kind: "approval" | "clarify";
  /** qid for batch clarifies; "" for single-question form. */
  qid: string;
  /** Wire-specific answer sender (WS srq response / ACP permission resolve). */
  respond: (outcome: ApprovalOutcome, answer?: string) => void;
  /** Resolves when the client answers (request.respond) or the ask is cancelled. */
  answered: Promise<{ outcome: ApprovalOutcome; answer?: string }>;
  settle: (v: { outcome: ApprovalOutcome; answer?: string }) => void;
  group?: {
    pending: Set<string>;
    answers: Record<string, string>;
    cancelled: boolean;
  };
}

export class Session {
  seq = 0;
  log: EngineEvent[] = [];
  state: SessionState = "idle";
  usage: Usage | undefined;
  openRequests = new Map<string, PendingAsk>();
  turn?: Turn;
  lastTurnId = "";
  /** #308: a post-turn leg the engine opened itself (queued-steer drain,
     delivery leg) mints its own turn id here — NOT `turn`, which is
     reserved for prompt() turns. A leg still counts as running work:
     prompt() and interrupt() treat it like a live turn (mid-work input
     goes through session.steer, queued as the next leg). */
  legTurnId?: string;
  /** Accepted steers the engine queued for the next leg, FIFO — the leg's
     turn.started echoes each entry's `ref` so the relay message the steer
     came from stays the turn's anchor (#308). */
  steeredQueue: { text: string; ref?: string }[] = [];
  /** #134: user inputs delivered (prompts + accepted steers) —
      `session.rewind` truncates Hermes history to this count's `toTurn`. */
  userTurns = 0;
  /** Hermes tool_call id -> LilOS toolCallId (stable per session). */
  toolIds = new Map<string, string>();
  toolCounter = 0;
  /* #179: flat subagent rows keyed on any child id the wire offers
     (subagent_id / child_session_id / delegation+index). */
  subIds = new Map<string, string>();
  subCounter = 0;
  subToolCounter = 0;
  /** In-flight delegate calls — a child run links to its spawning call. */
  delegateStack: string[] = [];
  /** In-flight `terminal {background:true}` calls -> their command. */
  terminalCalls = new Map<string, string>();
  /* #179: background jobs by hermes process id (`agent.terminal.output`
     process_id; `terminal.close` reports the OS pid — bridged by jobByPid). */
  jobs = new Map<string, HermesJob>();
  jobByPid = new Map<number, string>();
  /** jobId -> throttle timer for the rolling job.output tail. */
  jobFlush = new Map<string, ReturnType<typeof setTimeout>>();
  /** Reconcile timer while any job runs (silent exits have no push frame). */
  jobPoll?: ReturnType<typeof setInterval>;

  /** Stable LilOS subagentId for a wire-level child key. */
  subagentId(key: string): string {
    let id = this.subIds.get(key);
    if (!id) {
      id = `sa${++this.subCounter}`;
      this.subIds.set(key, id);
    }
    return id;
  }
  constructor(
    readonly id: string,
    readonly agent: string,
    readonly cwd: string,
    /** Current model pin (session.setModel rewrites it). */
    public model: string | undefined,
    readonly mcpServers: McpServer[],
    /** The rest of the session's pick (#92): provider slug, effort, fast. */
    public provider: string | undefined,
    public effort: string | undefined,
    public fast: boolean | undefined,
    readonly driver: DriverKind,
    /** Hermes gateway sid (stable for the connection's life). */
    public runtimeSid: string,
    /** Durable ref (stored_session_id) — rotates on compression. */
    public ref: string,
    private emitFn: (e: EngineEvent) => void,
  ) {}

  emit(type: EngineEventType, payload: EngineEvent["payload"]) {
    const event = {
      seq: ++this.seq,
      sessionId: this.id,
      type,
      payload,
    } as EngineEvent;
    this.log.push(event);
    this.emitFn(event);
  }

  setState(state: SessionState, reason?: string) {
    if (this.state === state) return;
    this.state = state;
    this.emit("session.state", reason ? { state, reason } : { state });
  }

  /** Engine-written title, tracked so the snapshot can carry it (#137). */
  title: string | undefined;

  /* #137 AC-1: mirror a persisted engine title into `session.titled`.
     Hermes drops the stage on the wire — `session.title` events carry only
     `{session_id, title}` (prompt_turn.py) and `session.info` carries the
     current `title` — so the first title observed is "derived" and any
     later change is "llm" (Hermes persists auto titles in that order and
     its title_source CAS stops them once a user name lands). User renames
     preset `s.title` in sessionSetTitle, so their echoes dedupe here. */
  applyTitle(title: string) {
    if (!title || title === this.title) return;
    const source = this.title ? "llm" : "derived";
    this.title = title;
    this.emit("session.titled", { title, source });
  }

  snapshot() {
    return {
      sessionId: this.id,
      state: this.state,
      turn: this.turn
        ? { turnId: this.turn.turnId, phase: this.turn.phase }
        : undefined,
      usage: this.usage,
      model: this.model,
      provider: this.provider,
      effort: this.effort,
      fast: this.fast,
      ...(this.title ? { title: this.title } : {}),
    };
  }

  eventsSince(after: number) {
    return {
      events: this.log.filter((e) => e.seq > after),
      latestSeq: this.seq,
      truncated: false,
      openRequests: [...this.openRequests.values()].map((a) => ({
        requestId: a.requestId,
        turnId: a.turnId,
        request: a.request,
        seq: a.seq,
      })),
      snapshot: this.snapshot(),
    };
  }

  toolCallId(hermesToolId: string): string {
    let id = this.toolIds.get(hermesToolId);
    if (!id) {
      id = `c${++this.toolCounter}`;
      this.toolIds.set(hermesToolId, id);
    }
    return id;
  }

  /** Subagent ids minted under one parent call (ACP-synthesized rows). */
  subagentsForCall(callId: string): string[] {
    const prefix = `${callId}:`;
    return [...this.subIds.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => this.subIds.get(k) as string);
  }
}

/** Resolve an open ask as cancelled and emit request.resolved. */
export function cancelAsk(s: Session, ask: PendingAsk) {
  if (!s.openRequests.delete(ask.requestId)) return;
  s.emit("request.resolved", { requestId: ask.requestId, outcome: "cancel" });
  ask.settle({ outcome: "cancel" });
  ask.respond("cancel");
}

/** Cancel every open ask on the session (interrupt / stop / wire cancel). */
export function cancelAllAsks(s: Session) {
  for (const ask of [...s.openRequests.values()]) cancelAsk(s, ask);
}

export function resolveOutcomeValid(ask: PendingAsk, outcome: ApprovalOutcome) {
  if (ask.request.kind === "approval") {
    if (outcome === "answer")
      return "an approval takes once/always/deny/cancel, not answer";
    if (!ask.request.options.includes(outcome as never))
      return `outcome ${outcome} not in offered options`;
    return undefined;
  }
  if (outcome !== "answer" && outcome !== "cancel")
    return "a question takes answer or cancel";
  return undefined;
}

export function requestNotFound(id: string): RpcError {
  return new RpcError(RPC_ERRORS.REQUEST_NOT_FOUND, `no open request ${id}`);
}
