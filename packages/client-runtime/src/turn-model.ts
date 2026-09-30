import type {
  ApprovalOutcome,
  CommitInfo,
  EngineEvent,
  EngineRequest,
  FileDiff,
  JobStatus,
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
  /** Ms epoch the helper was dispatched (drives its job row's uptime). */
  startedAt?: number;
  /** Set when the helper is another employee (D-#25). */
  employee?: { employeeRef: string; sessionRef: string };
}

/** A background process the engine left running (job.* events / jobs.list). */
export interface JobModel {
  jobId: string;
  command: string;
  status: JobStatus;
  startedAt?: number;
  /** Ms epoch the job exited — the row's uptime freezes at it. */
  endedAt?: number;
  exitCode?: number;
  url?: string;
  /** Subagent name when a helper spawned it. */
  by?: string;
  /** Rolling output tail (job.output replaces, never appends). */
  tail: string;
  /** Synthesized subagent row (#309 `subagentJobs`) — jobs.stop can't kill
      it, so surfaces hide the Stop affordance. */
  subagent?: boolean;
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
  /** Helpers the session delegated to, as job-like rows (`sa:` jobIds) so
      the Background tab lists a subagent still working past its turn
      (#309). */
  subagentJobs: JobModel[];
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
        plans: [],
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
        /* #309: an async subagent's calls land after its parent's
           turn.completed — they nest under the helper's row and must not
           reopen the settled turn. The engine stamps them with whichever
           turn is CURRENT (not the spawning one), so the lookup crosses
           turns just like subagent.completed does. */
        if (t.phase !== "done" && t.phase !== "stopped") t.phase = "tools";
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
          const sa = findSubagent(parentId);
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
           "N steps" (decided default on the issue). The helper may sit on
           a different turn than the stamped one (#309 cross-turn steps). */
        const list = parentId
          ? (findSubagent(parentId)?.steps ?? orphanSteps.get(parentId))
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
        let sa = findSubagent(e.payload.subagentId);
        if (!sa) {
          sa = {
            subagentId: e.payload.subagentId,
            turnId: e.payload.turnId,
            name: e.payload.name,
            task: e.payload.task,
            status: "running",
            steps: [],
            startedAt: e.payload.startedAt,
          };
          t.subagents.push(sa);
        } else {
          sa.name = e.payload.name;
          sa.task = e.payload.task;
          sa.startedAt = e.payload.startedAt ?? sa.startedAt;
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
        const sa = findSubagent(e.payload.subagentId);
        if (sa) {
          sa.status = e.payload.status;
          sa.result = e.payload.result ?? sa.result;
          sa.durationMs = e.payload.durationMs ?? sa.durationMs;
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
        job.endedAt = e.payload.endedAt ?? job.endedAt;
        break;
      }
      case "request.opened": {
        const t = turn(e.payload.turnId);
        /* #309: a request stamped on a settled turn records but never
           reopens it — same post-turn guard tool.started takes. */
        if (t.phase !== "done" && t.phase !== "stopped") t.phase = "waiting";
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
        /* #309: an async delegate call closes with its dispatch receipt —
           the turn ending does not settle helpers it spawned; they run
           past turn end until the engine's real subagent.completed lands.
           A cancelled turn kills the work tree instead: no close arrives,
           so running rows settle "stopped" here. */
        if (e.payload.stopReason === "cancelled") {
          for (const sa of t.subagents) {
            if (sa.status === "running") sa.status = "stopped";
          }
        }
        break;
      }
    }
  }
  if (snapshot) state = snapshot.state;

  /* A helper by id across every turn — subagent.* frames are stamped
     with whichever turn is open, not the one that spawned it (#309). */
  function findSubagent(id: string): SubagentModel | undefined {
    for (const t of order) {
      const sa = t.subagents.find((s) => s.subagentId === id);
      if (sa) return sa;
    }
    return undefined;
  }

  /* The newest snapshot for a planId, or undefined (#180). */
  function latestPlan(t: TurnModel, planId: string): TurnPlan | undefined {
    for (let i = t.plans.length - 1; i >= 0; i--) {
      if (t.plans[i].planId === planId) return t.plans[i];
    }
    return undefined;
  }

  const live = order.find((t) => t.phase !== "done" && t.phase !== "stopped");
  const openRequests: TurnRequest[] = [];
  const jobList = [...jobs.values()];
  /* #309: helpers as job-like rows — a subagent left running past its
     turn lands on the Background tab (web) and the thread's job rows
     (mobile) through the same feed, next to real jobs (which can also
     carry by: <subagent name>). */
  const SUBAGENT_JOB_STATUS: Record<SubagentModel["status"], JobStatus> = {
    running: "running",
    done: "exited",
    failed: "failed",
    stopped: "stopped",
  };
  const subagentJobs: JobModel[] = order.flatMap((t) =>
    t.subagents.map((sa) => ({
      jobId: `sa:${sa.subagentId}`,
      command: sa.task || sa.name,
      status: SUBAGENT_JOB_STATUS[sa.status],
      /* Real times, not "up 0s": dispatch epoch while it runs; the
         engine's reported duration freezes the finished row. */
      ...(sa.startedAt !== undefined ? { startedAt: sa.startedAt } : {}),
      ...(sa.status !== "running" && sa.startedAt !== undefined
        ? { endedAt: sa.startedAt + (sa.durationMs ?? 0) }
        : {}),
      by: sa.name,
      tail: sa.result ?? "",
      subagent: true,
    })),
  );
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
    subagentJobs,
    model,
    provider,
    effort,
    fast,
  };
}
