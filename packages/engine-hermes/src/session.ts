import {
  type ApprovalOutcome,
  type EngineEvent,
  type EngineEventType,
  type EngineRequest,
  type McpServer,
  RPC_ERRORS,
  type SessionState,
  type Usage,
} from "@lilos/contracts/engine";
import { RpcError } from "./errors.js";

export type DriverKind = "ws" | "acp";

export interface Turn {
  turnId: string;
  phase: "reasoning" | "tools" | "text" | "waiting";
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
  /** Hermes tool_call id -> LilOS toolCallId (stable per session). */
  toolIds = new Map<string, string>();
  toolCounter = 0;

  constructor(
    readonly id: string,
    readonly agent: string,
    readonly cwd: string,
    /** Current model pin (session.setModel rewrites it). */
    public model: string | undefined,
    readonly mcpServers: McpServer[],
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

  snapshot() {
    return {
      sessionId: this.id,
      state: this.state,
      turn: this.turn
        ? { turnId: this.turn.turnId, phase: this.turn.phase }
        : undefined,
      usage: this.usage,
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
