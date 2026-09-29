import type {
  ApprovalOutcome,
  CommitInfo,
  EngineEvent,
  EngineRequest,
  FileDiff,
  JobStatus,
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

/* ── subagents + background jobs (#179) ────────────────────────────────── */

/** A helper an engine spun off inside a turn (subagent.started/completed +
   tool.* events carrying parentToolCallId). */
export interface SubagentModel {
  subagentId: string;
  turnId: string;
  parentToolCallId?: string;
  name: string;
  task: string;
  status: "running" | "done" | "failed" | "stopped";
  steps: TurnStep[];
  result?: string;
  durationMs?: number;
  /** Set when the helper is another employee (D-#25). */
  employee?: { employeeRef: string; sessionRef: string };
}

/** A background process the engine left running (job.* events / jobs.list). */
export interface JobModel {
  jobId: string;
  command: string;
  status: JobStatus;
  startedAt?: number;
  exitCode?: number;
  url?: string;
  /** Subagent name when a helper spawned it. */
  by?: string;
  /** Rolling output tail (job.output replaces, never appends). */
  tail: string;
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
  /** Helpers this turn delegated to (subagent.* events, #179). */
  subagents: SubagentModel[];
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
  /** Background processes of this session (job.* / jobs.list, #179). */
  jobs: JobModel[];
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
  /* #179: session-scoped state. `subagentId` is unique per session; steps
     arriving before their subagent.started buffer per parent id. */
  const jobs = new Map<string, JobModel>();
  const orphanSteps = new Map<string, TurnStep[]>();
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
        subagents: [],
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
        const step = {
          id: e.payload.toolCallId,
          tool: e.payload.tool,
          input: e.payload.input,
          status: "running" as const,
        };
        /* #179: a call nested under a subagent lands on the subagent's step
           list; when the subagent.started hasn't arrived yet it buffers. */
        const parentId = e.payload.parentToolCallId;
        if (parentId) {
          const sa = t.subagents.find((s) => s.subagentId === parentId);
          if (sa) sa.steps.push(step);
          else
            (orphanSteps.get(parentId) ?? []).length
              ? orphanSteps.get(parentId)?.push(step)
              : orphanSteps.set(parentId, [step]);
        } else {
          t.steps.push(step);
        }
        break;
      }
      case "tool.completed": {
        const t = turn(e.payload.turnId);
        const parentId = e.payload.parentToolCallId;
        /* #179: nested calls update the subagent's list, never the parent's
           "N steps" (decided default on the issue). */
        const list = parentId
          ? (t.subagents.find((s) => s.subagentId === parentId)?.steps ??
            orphanSteps.get(parentId))
          : t.steps;
        if (!list) {
          orphanSteps.set(parentId ?? "", [
            {
              id: e.payload.toolCallId,
              tool: e.payload.tool,
              input: {},
              status: e.payload.status,
              output: e.payload.output,
              diff: e.payload.diff,
              commit: e.payload.commit,
            },
          ]);
          break;
        }
        const step = list.find((s) => s.id === e.payload.toolCallId);
        if (step) {
          step.status = e.payload.status;
          step.output = e.payload.output;
          step.diff = e.payload.diff;
          step.commit = e.payload.commit;
        } else {
          list.push({
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
      /* ── subagents (#179) ── */
      case "subagent.started": {
        const t = turn(e.payload.turnId);
        let sa = t.subagents.find((s) => s.subagentId === e.payload.subagentId);
        if (!sa) {
          sa = {
            subagentId: e.payload.subagentId,
            turnId: e.payload.turnId,
            name: e.payload.name,
            task: e.payload.task,
            status: "running",
            steps: [],
          };
          t.subagents.push(sa);
        } else {
          sa.name = e.payload.name;
          sa.task = e.payload.task;
        }
        sa.parentToolCallId = e.payload.parentToolCallId ?? sa.parentToolCallId;
        sa.employee = e.payload.employee ?? sa.employee;
        /* Flush calls buffered before the started frame arrived. */
        const buffered = orphanSteps.get(e.payload.subagentId);
        if (buffered) {
          sa.steps.push(...buffered);
          orphanSteps.delete(e.payload.subagentId);
        }
        break;
      }
      case "subagent.completed": {
        for (const t of order) {
          const sa = t.subagents.find(
            (s) => s.subagentId === e.payload.subagentId,
          );
          if (!sa) continue;
          sa.status = e.payload.status;
          sa.result = e.payload.result ?? sa.result;
          sa.durationMs = e.payload.durationMs ?? sa.durationMs;
          break;
        }
        break;
      }
      /* ── background jobs (#179): session-scoped, merge by jobId ── */
      case "job.started": {
        const existing = jobs.get(e.payload.jobId);
        if (existing) {
          existing.command = e.payload.command;
          existing.startedAt = e.payload.startedAt ?? existing.startedAt;
          existing.url = e.payload.url ?? existing.url;
          existing.by = e.payload.by ?? existing.by;
        } else {
          jobs.set(e.payload.jobId, {
            jobId: e.payload.jobId,
            command: e.payload.command,
            status: "running",
            startedAt: e.payload.startedAt,
            url: e.payload.url,
            by: e.payload.by,
            tail: "",
          });
        }
        break;
      }
      case "job.output": {
        const job = jobs.get(e.payload.jobId);
        if (!job) break;
        job.tail = e.payload.tail;
        job.url = e.payload.url ?? job.url;
        break;
      }
      case "job.exited": {
        const job = jobs.get(e.payload.jobId);
        if (!job) break;
        job.status = e.payload.status;
        job.exitCode = e.payload.exitCode ?? job.exitCode;
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
        /* #179: the turn ended without a subagent.completed for a helper the
           engine still listed running — its delegate call can't outlive the
           turn, so the row settles "stopped". */
        for (const sa of t.subagents) {
          if (sa.status === "running") sa.status = "stopped";
        }
        break;
      }
    }
  }
  if (snapshot) state = snapshot.state;

  const live = order.find((t) => t.phase !== "done" && t.phase !== "stopped");
  const openRequests: TurnRequest[] = [];
  const jobList = [...jobs.values()];
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
    jobs: jobList,
    model,
    provider,
    effort,
    fast,
  };
}
