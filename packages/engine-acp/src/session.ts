import {
  type ApprovalOutcome,
  capEventLog,
  coalesceTurnDeltas,
  type EngineEvent,
  type EngineEventType,
  type EngineRequest,
  EVENT_LOG_CAP,
  type SessionState,
  type Usage,
} from "@lilos/contracts/engine";
import type { AcpSessionView } from "./mapping.js";

/**
 * D-#764 — the LilOS-side session record for one ACP session: event log
 * (events.since replay), open asks, turn/plan/usage bookkeeping. Mirrors the
 * minimal surface `handleAcpUpdate` writes through (AcpSessionView) so the
 * shared mapping emits identical frames here and inside engine-hermes.
 */

export interface PendingAcpAsk {
  requestId: string;
  turnId: string;
  request: EngineRequest;
  seq: number;
  answered: Promise<{ outcome: ApprovalOutcome; answer?: string }>;
  /** Resolves `answered`; the permission epilogue sends the ACP response
      and emits request.resolved for whoever still owns the ask. */
  settle: (v: { outcome: ApprovalOutcome; answer?: string }) => void;
}

export interface AcpTurn {
  turnId: string;
  phase: "reasoning" | "tools" | "text" | "waiting";
  plan?: { planId: string; version: number };
}

export class AcpSession implements AcpSessionView {
  seq = 0;
  log: EngineEvent[] = [];
  droppedSeq = 0;
  openTurnSeq?: number;
  state: SessionState = "idle";
  usage: Usage | undefined;
  openRequests = new Map<string, PendingAcpAsk>();
  turn?: AcpTurn;
  lastTurnId = "";
  title?: string;

  /** The agent's own session id (session/new -> sessionId). */
  acpSessionId = "";
  /** Suspended LilOS-side: the next prompt resumes/reattaches (#346). */
  suspended = false;
  /** The caller's stable key for the wedged-create guard — the
     conversation id when session.start carried one, else this LilOS
     id (r9: cwd keying cross-blocked conversations sharing a folder
     — every folderless chat sits in `~`). */
  callerKey = "";
  /** The session's live config-option table (from its own session/new). */
  configOptions = new Map<
    string,
    import("./capabilities.js").EngineConfigOption
  >();
  /** Session-mode state when advertised. */
  modes?: { current: string; available: { id: string; name?: string }[] };
  /** The access hint session.start ran under — a suspend/resume re-creates
     the ACP session, so the shim's sessionMeta needs it again (D-#866). */
  access?: "ask" | "full";
  /** The pick this session resolved (config currentValues + our writes). */
  model?: string;
  effort?: string;
  fast?: boolean;
  /** D-#846: the pick the user/defaults requested and the live session
     took — fields that actually wrote land here so a suspend/resume can
     re-apply them (a reloaded ACP session may return to agent defaults). */
  pick?: { model?: string; effort?: string; fast?: boolean };
  /** Steers accepted mid-turn — pumped as the next prompt, FIFO (#308). */
  steeredQueue: { text: string; ref?: string }[] = [];
  /** session.setTitle writes here — outranks every later titled upgrade. */
  userTitle?: string;
  hidden = false;
  /** Auto-title stage already emitted ("derived" at first turn start). */
  titledStage?: "derived" | "llm";

  constructor(
    readonly id: string,
    readonly agent: string,
    public cwd: string,
    private emitFn: (e: EngineEvent) => void,
    public eventLogCap = EVENT_LOG_CAP,
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
    if (type === "turn.started") this.openTurnSeq = event.seq;
    if (type === "turn.completed") {
      coalesceTurnDeltas(this.log, (payload as { turnId: string }).turnId);
      this.openTurnSeq = undefined;
    }
    const dropped = capEventLog(this.log, this.eventLogCap, this.openTurnSeq);
    if (dropped > this.droppedSeq) this.droppedSeq = dropped;
  }

  setState(state: SessionState, reason?: string) {
    if (this.state !== state) {
      this.state = state;
      this.emit("session.state", reason ? { state, reason } : { state });
    }
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
      effort: this.effort,
      fast: this.fast,
      ...(this.title ? { title: this.title } : {}),
      hidden: this.hidden,
    };
  }

  eventsSince(after: number) {
    return {
      events: this.log.filter((e) => e.seq > after),
      latestSeq: this.seq,
      truncated: this.droppedSeq > after,
      openRequests: [...this.openRequests.values()].map((a) => ({
        requestId: a.requestId,
        turnId: a.turnId,
        request: a.request,
        seq: a.seq,
      })),
      snapshot: this.snapshot(),
    };
  }
}

/**
 * Resolve an open ask as cancelled NOW: emits request.resolved and wakes
 * the permission epilogue, which sees the ask already gone and skips its
 * own resolved emit — the cancel path owns the frame.
 */
export function cancelAcpAsk(s: AcpSession, ask: PendingAcpAsk) {
  if (!s.openRequests.delete(ask.requestId)) return;
  s.emit("request.resolved", { requestId: ask.requestId, outcome: "cancel" });
  ask.settle({ outcome: "cancel" });
}

export function cancelAllAcpAsks(s: AcpSession) {
  for (const ask of [...s.openRequests.values()]) cancelAcpAsk(s, ask);
}
