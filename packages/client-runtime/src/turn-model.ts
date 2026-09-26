import type {
  ApprovalOutcome,
  CommitInfo,
  EngineEvent,
  EngineRequest,
  FileDiff,
  SessionState,
  Usage,
} from "@lilos/contracts/engine";

/** One engine tool call inside a turn (tool.started -> tool.completed). */
export interface TurnStep {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  status: "running" | "completed" | "failed" | "denied" | "cancelled";
  output?: string;
  diff?: FileDiff;
  commit?: CommitInfo;
}

/** An open or answered engine request (approval / question). */
export interface TurnRequest {
  requestId: string;
  turnId: string;
  request: EngineRequest;
  outcome?: ApprovalOutcome;
  answer?: string;
}

export type TurnPhase =
  | "submitted"
  | "reasoning"
  | "tools"
  | "text"
  | "waiting"
  | "done"
  | "stopped";

/** The UI-ready model of one engine turn, reduced from its event log. */
export interface TurnModel {
  turnId: string;
  phase: TurnPhase;
  model?: string;
  reasoning: string;
  text: string;
  steps: TurnStep[];
  steers: string[];
  requests: TurnRequest[];
  usage?: Usage;
  stopReason?: string;
}

export interface SessionModel {
  sessionId: string;
  state: SessionState | "unknown";
  turns: TurnModel[];
  /** The turn currently producing output (phase not done/stopped). */
  live?: TurnModel;
  /** Requests still awaiting request.respond. */
  openRequests: TurnRequest[];
  model?: string;
}

/**
 * Reduce one session's engine event log (+ optional snapshot) into turn
 * models for rendering. Pure and replay-safe: feed it the events.since log,
 * the session feed atom's events, or a live stream — same result.
 */
export function reduceSessionEvents(
  sessionId: string,
  events: EngineEvent[],
  snapshot?: { state: SessionState; model?: string; turn?: { turnId: string } },
): SessionModel {
  const turns = new Map<string, TurnModel>();
  const order: TurnModel[] = [];
  let state: SessionState | "unknown" = "unknown";
  let model: string | undefined = snapshot?.model;

  const turn = (turnId: string): TurnModel => {
    let t = turns.get(turnId);
    if (!t) {
      t = {
        turnId,
        phase: "submitted",
        reasoning: "",
        text: "",
        steps: [],
        steers: [],
        requests: [],
      };
      turns.set(turnId, t);
      order.push(t);
    }
    return t;
  };

  for (const e of events) {
    if (e.sessionId !== sessionId) continue;
    switch (e.type) {
      case "session.started": {
        model = e.payload.model ?? model;
        break;
      }
      case "session.state": {
        state = e.payload.state;
        break;
      }
      case "turn.started": {
        const t = turn(e.payload.turnId);
        t.phase = "reasoning";
        t.model = e.payload.model ?? t.model;
        break;
      }
      case "turn.delta": {
        const t = turn(e.payload.turnId);
        if (e.payload.stream === "reasoning") {
          t.reasoning += e.payload.delta;
          if (t.phase === "submitted") t.phase = "reasoning";
        } else {
          t.text += e.payload.delta;
          if (t.phase !== "done" && t.phase !== "stopped") t.phase = "text";
        }
        break;
      }
      case "tool.started": {
        const t = turn(e.payload.turnId);
        t.phase = "tools";
        t.steps.push({
          id: e.payload.toolCallId,
          tool: e.payload.tool,
          input: e.payload.input,
          status: "running",
        });
        break;
      }
      case "tool.completed": {
        const t = turn(e.payload.turnId);
        const step = t.steps.find((s) => s.id === e.payload.toolCallId);
        if (step) {
          step.status = e.payload.status;
          step.output = e.payload.output;
          step.diff = e.payload.diff;
          step.commit = e.payload.commit;
        } else {
          t.steps.push({
            id: e.payload.toolCallId,
            tool: e.payload.tool,
            input: {},
            status: e.payload.status,
            output: e.payload.output,
            diff: e.payload.diff,
            commit: e.payload.commit,
          });
        }
        break;
      }
      case "request.opened": {
        const t = turn(e.payload.turnId);
        t.phase = "waiting";
        t.requests.push({
          requestId: e.payload.requestId,
          turnId: e.payload.turnId,
          request: e.payload.request,
        });
        break;
      }
      case "request.resolved": {
        const { requestId, outcome, answer } = e.payload;
        const t = order.find((x) =>
          x.requests.some((r) => r.requestId === requestId),
        );
        const req = t?.requests.find((r) => r.requestId === requestId);
        if (req) {
          req.outcome = outcome;
          req.answer = answer;
          if (t && t.phase === "waiting") t.phase = "reasoning";
        }
        break;
      }
      case "turn.steered": {
        turn(e.payload.turnId).steers.push(e.payload.text);
        break;
      }
      case "turn.completed": {
        const t = turn(e.payload.turnId);
        t.phase = e.payload.stopReason === "cancelled" ? "stopped" : "done";
        t.stopReason = e.payload.stopReason;
        t.usage = e.payload.usage;
        break;
      }
    }
  }
  if (snapshot) state = snapshot.state;

  const live = order.find((t) => t.phase !== "done" && t.phase !== "stopped");
  const openRequests: TurnRequest[] = [];
  for (const t of order) {
    for (const r of t.requests) {
      if (r.outcome === undefined) openRequests.push(r);
    }
  }
  return { sessionId, state, turns: order, live, openRequests, model };
}
