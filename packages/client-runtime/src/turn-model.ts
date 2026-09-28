import type {
  ApprovalOutcome,
  CommitInfo,
  EngineEvent,
  EngineRequest,
  FileDiff,
  PlanStep,
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

/** An open or answered engine request (approval / question / plan). */
export interface TurnRequest {
  requestId: string;
  turnId: string;
  request: EngineRequest;
  outcome?: ApprovalOutcome;
  answer?: string;
}

/**
 * One snapshot of an engine plan / task list (`plan.updated`), with its
 * decision state derived from the plan request lifecycle (#180):
 * `kind:"tasks"` runs approved from the start (it never asks);
 * `kind:"plan"` waits proposed until its request resolves — approve ->
 * approved, reject -> rejected, change -> replaced (the next version is
 * what the user decided on). A snapshot with a higher `version` supersedes
 * the previous one, which stays in the list marked `replaced` for the
 * Workbench's version history.
 */
export interface TurnPlan {
  planId: string;
  kind: "tasks" | "plan";
  version: number;
  goal?: string;
  steps: PlanStep[];
  risks?: string[];
  status: "proposed" | "approved" | "replaced" | "rejected";
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
  /** The rest of the pick this turn ran on (#92): provider, effort, fast. */
  provider?: string;
  effort?: string;
  fast?: boolean;
  reasoning: string;
  text: string;
  steps: TurnStep[];
  steers: string[];
  requests: TurnRequest[];
  /** Plan/task-list snapshots this turn produced, arrival order (#180). */
  plans: TurnPlan[];
  usage?: Usage;
  stopReason?: string;
  /** The user message that prompted this turn (engine `turn.started.ref`). */
  ref?: string;
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
  provider?: string;
  effort?: string;
  fast?: boolean;
}

/**
 * Reduce one session's engine event log (+ optional snapshot) into turn
 * models for rendering. Pure and replay-safe: feed it the events.since log,
 * the session feed atom's events, or a live stream — same result.
 */
export function reduceSessionEvents(
  sessionId: string,
  events: EngineEvent[],
  snapshot?: {
    state: SessionState;
    model?: string;
    provider?: string;
    effort?: string;
    fast?: boolean;
    turn?: { turnId: string };
  },
): SessionModel {
  const turns = new Map<string, TurnModel>();
  const order: TurnModel[] = [];
  let state: SessionState | "unknown" = "unknown";
  let model: string | undefined = snapshot?.model;
  let provider: string | undefined = snapshot?.provider;
  let effort: string | undefined = snapshot?.effort;
  let fast: boolean | undefined = snapshot?.fast;

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
        plans: [],
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
        provider = e.payload.provider ?? provider;
        effort = e.payload.effort ?? effort;
        fast = e.payload.fast ?? fast;
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
        t.provider = e.payload.provider ?? t.provider;
        t.effort = e.payload.effort ?? t.effort;
        t.fast = e.payload.fast ?? t.fast;
        t.ref = e.payload.ref ?? t.ref;
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
          /* A plan request's answer lands on the plan it decided (#180):
             approve -> the checklist runs; reject -> nothing runs;
             change -> this version is superseded by what comes back. */
          if (t && req.request.kind === "plan") {
            const plan = latestPlan(t, req.request.planId);
            if (plan) {
              if (outcome === "approve") plan.status = "approved";
              else if (outcome === "reject") plan.status = "rejected";
              else if (outcome === "change") plan.status = "replaced";
            }
          }
        }
        break;
      }
      case "plan.updated": {
        const t = turn(e.payload.turnId);
        const { planId, kind, version, goal, steps, risks } = e.payload;
        const current = latestPlan(t, planId);
        if (!current) {
          t.plans.push({
            planId,
            kind,
            version,
            ...(goal !== undefined ? { goal } : {}),
            steps,
            ...(risks !== undefined ? { risks } : {}),
            /* Task lists never ask — they run approved from their first
               snapshot. A proposal waits on its plan request. */
            status: kind === "tasks" ? "approved" : "proposed",
          });
        } else if (kind === "tasks" || version === current.version) {
          /* A task list's version counts ticks, not revisions — always
             update the single entry in place. A proposal's version IS the
             revision the user decided on, so equal versions merge and only
             a bump supersedes. */
          current.version = Math.max(current.version, version);
          current.goal = goal;
          current.steps = steps;
          current.risks = risks;
        } else if (version > current.version) {
          current.status = "replaced";
          t.plans.push({
            planId,
            kind,
            version,
            ...(goal !== undefined ? { goal } : {}),
            steps,
            ...(risks !== undefined ? { risks } : {}),
            status: "proposed",
          });
        }
        // kind "plan" with version < current: an out-of-order re-send —
        // the latest wins.
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
        /* Stopped mid-list (#180 AC-2): engines don't re-emit a cancelled
           snapshot on interrupt, so unfinished items derive it here — the
           card reads "Stopped · n/m" from the steps alone. */
        if (e.payload.stopReason === "cancelled") {
          for (const p of t.plans) {
            for (const s of p.steps) {
              if (s.status === "pending" || s.status === "in_progress") {
                s.status = "cancelled";
              }
            }
          }
        }
        break;
      }
    }
  }
  if (snapshot) state = snapshot.state;

  /* The newest snapshot for a planId, or undefined (#180). */
  function latestPlan(t: TurnModel, planId: string): TurnPlan | undefined {
    for (let i = t.plans.length - 1; i >= 0; i--) {
      if (t.plans[i].planId === planId) return t.plans[i];
    }
    return undefined;
  }

  const live = order.find((t) => t.phase !== "done" && t.phase !== "stopped");
  const openRequests: TurnRequest[] = [];
  for (const t of order) {
    for (const r of t.requests) {
      if (r.outcome === undefined) openRequests.push(r);
    }
  }
  return {
    sessionId,
    state,
    turns: order,
    live,
    openRequests,
    model,
    provider,
    effort,
    fast,
  };
}
