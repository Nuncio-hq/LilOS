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
}

export type TurnPhase =
  | "submitted"
  | "reasoning"
  | "tools"
  | "text"
  | "waiting"
  | "done"
  | "stopped"
  /* #419: the turn ended on `turn.completed.error` — terminal like done
     (never live, never reopened), but it failed and reads that way. */
  | "failed";

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
  /** #419: `turn.completed.error` — the engine's failure text, kept so
     surfaces can say *what* failed instead of a bare `failed` phase. */
  error?: string;
  /** The user message that prompted this turn (engine `turn.started.ref`). */
  ref?: string;
  /** #308: the engine opened this leg itself (delivery/auto-continue) —
      renders as its own agent entry, never claimed by a posted answer. */
  agentInitiated?: boolean;
  /** #396: this turn's `turn.started` seq ran past the attach snapshot's
      watermark — the turn began while this feed was attached, vs replayed
      history already running when the view mounted. Unset when the reduce
      ran without an attach snapshot (mocks/tests keep the old meaning). */
  postAttach?: boolean;
  /** #370: any of this turn's events ran past the attach watermark — the
      feed watched it work or finish rather than replaying it as history.
      mergeTurns keeps its finished card through the settle→claim window:
      its answer's relay row is still in flight, so the card is
      reply-pending, not an orphan like #288's replayed re-answer. Unset
      when the reduce ran without an attach snapshot. */
  liveAttached?: boolean;
}

export interface SessionModel {
  sessionId: string;
  state: SessionState | "unknown";
  turns: TurnModel[];
  /** The turn currently producing output (phase not done/stopped/failed). */
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

/** The attach-snapshot slice the reducer reads (the feed's
    `events.since` snapshot + its `atSeq` watermark, #467/#327). */
export interface ReduceSnapshot {
  state: SessionState;
  model?: string;
  provider?: string;
  effort?: string;
  fast?: boolean;
  turn?: { turnId: string };
  /** The seq the snapshot was captured at (the feed's replay
      watermark). Live frames keep appending past it without touching
      the snapshot — when set, an event beyond it marks the snapshot
      stale so its `state`/`turn` can't outrank the live stream. */
  atSeq?: number;
}

const TERMINAL = new Set<TurnPhase>(["done", "stopped", "failed"]);

/**
 * #430: one session's event log → turn models, applied INCREMENTALLY.
 *
 * The old `reduceSessionEvents` replayed the whole log on every feed
 * change — at 100 turns each streamed word re-ran ~1000 events, and every
 * emitted `SessionModel` held all-new `TurnModel` objects, so nothing
 * downstream could tell the 99 untouched turns from the one that changed.
 *
 * `SessionReducer` keeps the working model between `apply` calls: when
 * the new event list is a prefix-extension of the last (the steady state
 * for a live feed — feed-merge dedup keeps shared prefix elements
 * identical), only the new tail replays, and clone-on-write means a
 * `TurnModel` untouched by the tail keeps its object identity. Anything
 * else (a replaced prefix, a fresh attach snapshot) resets and replays
 * the full log — same answer as the one-shot reduce, by construction.
 *
 * The emitted `turns` array is always a fresh slice so `order` can swap
 * draft clones in without mutating a previously emitted model.
 */
export class SessionReducer {
  private readonly turns = new Map<string, TurnModel>();
  private order: TurnModel[] = [];
  /* #179: session-scoped state. `subagentId` is unique per session; steps
     arriving before their subagent.started buffer per parent id. */
  private readonly jobs = new Map<string, JobModel>();
  private readonly orphanSteps = new Map<string, TurnStep[]>();
  private state: SessionState | "unknown" = "unknown";
  private model: string | undefined;
  private provider: string | undefined;
  private effort: string | undefined;
  private fast: boolean | undefined;
  private snapshot: ReduceSnapshot | undefined;
  /* Latched once an event runs past the snapshot's atSeq — the #327
     stale check, computed while applying instead of re-scanned. */
  private snapshotStale = false;
  /* Events already applied — `lastEvents` is the caller's array (they
     own it; the feed only ever appends or replaces). */
  private applied = 0;
  private lastEvents: EngineEvent[] | undefined;
  /* Turn/job ids cloned in the current apply — a second write in the
     same batch hits the existing draft instead of cloning again. */
  private readonly draftTurns = new Set<string>();
  private readonly draftJobs = new Set<string>();

  constructor(private readonly sessionId: string) {}

  /** Fold `events` (the whole known log — the reducer keeps the cursor)
      under `snapshot` and return the current model. */
  apply(events: EngineEvent[], snapshot?: ReduceSnapshot): SessionModel {
    if (snapshot !== this.snapshot || !this.isPrefix(events)) {
      this.reset(snapshot);
    }
    for (let i = this.applied; i < events.length; i++) this.event(events[i]);
    this.applied = events.length;
    this.lastEvents = events;
    return this.emit();
  }

  /** The new list shares every applied element (same objects, same
      order) — only then can the tail be the only work. */
  private isPrefix(events: EngineEvent[]): boolean {
    const prev = this.lastEvents;
    if (!prev || events.length < this.applied) return false;
    for (let i = 0; i < this.applied; i++) {
      if (events[i] !== prev[i]) return false;
    }
    return true;
  }

  private reset(snapshot?: ReduceSnapshot): void {
    this.turns.clear();
    this.order = [];
    this.jobs.clear();
    this.orphanSteps.clear();
    this.state = "unknown";
    this.snapshot = snapshot;
    this.model = snapshot?.model;
    this.provider = snapshot?.provider;
    this.effort = snapshot?.effort;
    this.fast = snapshot?.fast;
    this.snapshotStale = false;
    this.applied = 0;
    this.lastEvents = undefined;
  }

  /* Clone-on-write: the first write to a committed turn in this batch
     swaps a fresh draft into `turns`/`order` — the previously emitted
     model's objects stay untouched. Nested lists a case can mutate
     (steps' fields, requests' outcomes, plans' steps, subagent steps)
     come along one level deep; replaced-not-mutated refs (diff, commit,
     usage, request, employee) ride the shallow copy. */
  private wTurn(turnId: string): TurnModel {
    const t = this.turns.get(turnId);
    if (!t) throw new Error(`SessionReducer.wTurn: no turn ${turnId}`);
    if (this.draftTurns.has(turnId)) return t;
    const c: TurnModel = {
      ...t,
      steps: t.steps.map((s) => ({ ...s })),
      steers: [...t.steers],
      requests: t.requests.map((r) => ({ ...r })),
      plans: t.plans.map((p) => ({
        ...p,
        steps: p.steps.map((s) => ({ ...s })),
        ...(p.risks ? { risks: [...p.risks] } : {}),
      })),
      subagents: t.subagents.map((sa) => ({
        ...sa,
        steps: sa.steps.map((s) => ({ ...s })),
        ...(sa.employee ? { employee: { ...sa.employee } } : {}),
      })),
    };
    this.turns.set(turnId, c);
    this.order[this.order.indexOf(t)] = c;
    this.draftTurns.add(turnId);
    return c;
  }

  /** Mint-or-write: the case handlers' `turn()` — a fresh mint is a
      draft already (no clone needed). */
  private turn(turnId: string): TurnModel {
    if (this.turns.has(turnId)) return this.wTurn(turnId);
    const t: TurnModel = {
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
    this.turns.set(turnId, t);
    this.order.push(t);
    this.draftTurns.add(turnId);
    return t;
  }

  /* A helper by id across every turn — subagent.* frames are stamped
     with whichever turn is open, not the one that spawned it (#309).
     Writeable: the owning turn is drafted before the row mutates. */
  private wSubagent(id: string): SubagentModel | undefined {
    for (const t of this.order) {
      if (t.subagents.some((s) => s.subagentId === id)) {
        const w = this.wTurn(t.turnId);
        return w.subagents.find((s) => s.subagentId === id);
      }
    }
    return undefined;
  }

  private wJob(jobId: string): JobModel | undefined {
    const j = this.jobs.get(jobId);
    if (!j) return undefined;
    if (this.draftJobs.has(jobId)) return j;
    const c = { ...j };
    this.jobs.set(jobId, c);
    this.draftJobs.add(jobId);
    return c;
  }

  /* The newest snapshot for a planId, or undefined (#180). */
  private latestPlan(t: TurnModel, planId: string): TurnPlan | undefined {
    for (let i = t.plans.length - 1; i >= 0; i--) {
      if (t.plans[i].planId === planId) return t.plans[i];
    }
    return undefined;
  }

  /* Unfinished plan steps read cancelled on a stopped turn — engines
     don't re-emit a cancelled snapshot (#180 AC-2). Shared by the
     user-stop path and the session-settle sweep (#327). */
  private cancelPlanSteps(t: TurnModel): void {
    for (const p of t.plans) {
      for (const s of p.steps) {
        if (s.status === "pending" || s.status === "in_progress") {
          s.status = "cancelled";
        }
      }
    }
  }

  private event(e: EngineEvent): void {
    if (e.sessionId !== this.sessionId) return;
    const atSeq = this.snapshot?.atSeq;
    if (atSeq !== undefined && e.seq > atSeq) this.snapshotStale = true;
    switch (e.type) {
      case "session.started": {
        this.model = e.payload.model ?? this.model;
        this.provider = e.payload.provider ?? this.provider;
        this.effort = e.payload.effort ?? this.effort;
        this.fast = e.payload.fast ?? this.fast;
        break;
      }
      case "session.state": {
        this.state = e.payload.state;
        break;
      }
      case "turn.started": {
        const t = this.turn(e.payload.turnId);
        t.phase = "reasoning";
        t.model = e.payload.model ?? t.model;
        t.provider = e.payload.provider ?? t.provider;
        t.effort = e.payload.effort ?? t.effort;
        t.fast = e.payload.fast ?? t.fast;
        t.ref = e.payload.ref ?? t.ref;
        /* #396: seq past the snapshot's attach watermark = the turn began
           while this feed was attached — the turn that started while you
           watch, vs the one already live when the view mounted. */
        t.postAttach = atSeq !== undefined && e.seq > atSeq;
        if (e.payload.initiatedBy === "agent") t.agentInitiated = true;
        break;
      }
      case "turn.delta": {
        const t = this.turn(e.payload.turnId);
        if (e.payload.stream === "reasoning") {
          t.reasoning += e.payload.delta;
          if (t.phase === "submitted") t.phase = "reasoning";
        } else {
          t.text += e.payload.delta;
          if (
            t.phase !== "done" &&
            t.phase !== "stopped" &&
            t.phase !== "failed"
          )
            t.phase = "text";
        }
        break;
      }
      case "turn.recap": {
        const t = this.turn(e.payload.turnId);
        /* #431: a finished turn's whole streams in one frame — replace,
           never append: the fold lands identically whether it saw the
           delta run or its recap (a client whose watermark sits inside
           the compacted run folds deltas up to it, then the recap
           re-stamps the full text at the last delta's seq). */
        t.reasoning = e.payload.reasoning;
        t.text = e.payload.text;
        if (
          e.payload.text &&
          t.phase !== "done" &&
          t.phase !== "stopped" &&
          t.phase !== "failed"
        )
          t.phase = "text";
        else if (e.payload.reasoning && t.phase === "submitted")
          t.phase = "reasoning";
        break;
      }
      case "tool.started": {
        const t = this.turn(e.payload.turnId);
        /* #309: an async subagent's calls land after its parent's
           turn.completed — they nest under the helper's row and must not
           reopen the settled turn. The engine stamps them with whichever
           turn is CURRENT (not the spawning one), so the lookup crosses
           turns just like subagent.completed does. */
        if (t.phase !== "done" && t.phase !== "stopped" && t.phase !== "failed")
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
          const sa = this.wSubagent(parentId);
          if (sa) sa.steps.push(step);
          else {
            const buffered = this.orphanSteps.get(parentId);
            if (buffered) buffered.push(step);
            else this.orphanSteps.set(parentId, [step]);
          }
        } else {
          t.steps.push(step);
        }
        break;
      }
      case "tool.completed": {
        const t = this.turn(e.payload.turnId);
        const parentId = e.payload.parentToolCallId;
        /* #179: nested calls update the subagent's list, never the parent's
           "N steps" (decided default on the issue). The helper may sit on
           a different turn than the stamped one (#309 cross-turn steps). */
        const list = parentId
          ? (this.wSubagent(parentId)?.steps ?? this.orphanSteps.get(parentId))
          : t.steps;
        if (!list) {
          this.orphanSteps.set(parentId ?? "", [
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
        const t = this.turn(e.payload.turnId);
        let sa = this.wSubagent(e.payload.subagentId);
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
        const buffered = this.orphanSteps.get(e.payload.subagentId);
        if (buffered) {
          sa.steps.push(...buffered);
          this.orphanSteps.delete(e.payload.subagentId);
        }
        break;
      }
      case "subagent.completed": {
        const sa = this.wSubagent(e.payload.subagentId);
        if (sa) {
          sa.status = e.payload.status;
          sa.result = e.payload.result ?? sa.result;
          sa.durationMs = e.payload.durationMs ?? sa.durationMs;
        }
        break;
      }
      /* ── background jobs (#179): session-scoped, merge by jobId ── */
      case "job.started": {
        const existing = this.wJob(e.payload.jobId);
        if (existing) {
          existing.command = e.payload.command;
          existing.startedAt = e.payload.startedAt ?? existing.startedAt;
          existing.url = e.payload.url ?? existing.url;
          existing.by = e.payload.by ?? existing.by;
        } else {
          const j: JobModel = {
            jobId: e.payload.jobId,
            command: e.payload.command,
            status: "running",
            startedAt: e.payload.startedAt,
            url: e.payload.url,
            by: e.payload.by,
            tail: "",
          };
          this.jobs.set(e.payload.jobId, j);
          this.draftJobs.add(e.payload.jobId);
        }
        break;
      }
      case "job.output": {
        const job = this.wJob(e.payload.jobId);
        if (!job) break;
        job.tail = e.payload.tail;
        job.url = e.payload.url ?? job.url;
        break;
      }
      case "job.exited": {
        const job = this.wJob(e.payload.jobId);
        if (!job) break;
        job.status = e.payload.status;
        job.exitCode = e.payload.exitCode ?? job.exitCode;
        job.endedAt = e.payload.endedAt ?? job.endedAt;
        break;
      }
      case "request.opened": {
        const t = this.turn(e.payload.turnId);
        /* #309: a request stamped on a settled turn records but never
           reopens it — same post-turn guard tool.started takes. */
        if (t.phase !== "done" && t.phase !== "stopped" && t.phase !== "failed")
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
        const owner = this.order.find((x) =>
          x.requests.some((r) => r.requestId === requestId),
        );
        if (owner) {
          const t = this.wTurn(owner.turnId);
          const req = t.requests.find((r) => r.requestId === requestId);
          if (req) {
            req.outcome = outcome;
            req.answer = answer;
            if (t.phase === "waiting") t.phase = "reasoning";
            /* A plan request's answer lands on the plan it decided (#180):
               approve -> the checklist runs; reject -> nothing runs;
               change -> this version is superseded by what comes back. */
            if (req.request.kind === "plan") {
              const plan = this.latestPlan(t, req.request.planId);
              if (plan) {
                if (outcome === "approve") plan.status = "approved";
                else if (outcome === "reject") plan.status = "rejected";
                else if (outcome === "change") plan.status = "replaced";
              }
            }
          }
        }
        break;
      }
      case "plan.updated": {
        const t = this.turn(e.payload.turnId);
        const { planId, kind, version, goal, steps, risks } = e.payload;
        const current = this.latestPlan(t, planId);
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
        this.turn(e.payload.turnId).steers.push(e.payload.text);
        break;
      }
      case "turn.completed": {
        const t = this.turn(e.payload.turnId);
        /* #419: an error payload means the turn failed — the stop reason
           stays on `stopReason` (refusal/cancelled/…) but the phase reads
           failed so nothing downstream treats it as a clean end. */
        t.phase = e.payload.error
          ? "failed"
          : e.payload.stopReason === "cancelled"
            ? "stopped"
            : "done";
        t.stopReason = e.payload.stopReason;
        t.error = e.payload.error;
        t.usage = e.payload.usage;
        /* Stopped mid-list (#180 AC-2): engines don't re-emit a cancelled
           snapshot on interrupt, so unfinished items derive it here — the
           card reads "Stopped · n/m" from the steps alone. */
        if (e.payload.stopReason === "cancelled") {
          this.cancelPlanSteps(t);
          /* #309: an async delegate call closes with its dispatch receipt —
             the turn ending does not settle helpers it spawned; they run
             past turn end until the engine's real subagent.completed lands.
             A cancelled turn kills the work tree instead: no close arrives,
             so running rows settle "stopped" here. */
          for (const sa of t.subagents) {
            if (sa.status === "running") sa.status = "stopped";
          }
        }
        break;
      }
    }
    /* #370: a turn-stamped frame past the attach watermark means this feed
       watched the turn live — `postAttach` generalized beyond
       turn.started. Marked only when the case minted/held the turn (a
       stray turnId on a frame that created none mints no phantom). */
    const tid = (e.payload as { turnId?: string }).turnId;
    if (tid !== undefined && atSeq !== undefined && e.seq > atSeq) {
      const t = this.turns.get(tid);
      if (t) this.wTurn(tid).liveAttached = true;
    }
  }

  /* Snapshot + settle + derived passes — the emit half of the old
     one-shot reduce, run per apply so every emitted model is complete.
     Settles go through `wTurn`: a turn the sweep closes is a real change
     and must not mutate the last emission's object. */
  private emit(): SessionModel {
    const snapshot = this.snapshot;
    /* #327: `snapshot.state` is true only at the watermark it was
       captured at. A live feed merges replay + `engine.event` frames into
       the same log while the snapshot stays frozen — an "idle" snapshot
       from the last sync must not settle a running turn the stream has
       already announced. Any event past `atSeq` makes it stale (callers
       that replay a closed log pass no `atSeq`, so it always applies). */
    const state = snapshot && !this.snapshotStale ? snapshot.state : this.state;

    /* #327: a turn can't stay live once its session is no longer running —
       engines emit `session.state` idle at every turn end and closed on
       close, so a still-open phase under either means its turn.completed
       was lost to a truncated or degraded replay (#300). A later turn in
       the log proves the same with no state event at all (engines run one
       turn at a time), and so does a snapshot naming another turn current.
       Requests orphaned on the settled turn cancel out like the engine's
       own turn-end cancelAllAsks; a still-"running" step cancels the same
       way (the tool.completed was lost with it). Helper rows settle only
       under closed/error — an async subagent legitimately runs through
       the idle gap between turns (#309), and an ACP-mode row the wire can
       never close is settled by the adapter where dead is provable
       (engine-hermes acp.ts), not guessed here. */
    const settle =
      state === "closed" || state === "error"
        ? ("stopped" as const)
        : state === "idle"
          ? ("done" as const)
          : undefined;
    const snapshotTurn = this.snapshotStale
      ? undefined
      : snapshot?.turn?.turnId;
    /* The settle is a PROJECTION onto the emitted turns, never written
       into the working model: a turn minted while the last-known session
       state was still idle/closed reads settled at this prefix, but a
       later apply (the state event landing a frame after turn.started)
       must revive it — the one-shot reducer self-healed the same way by
       replaying `turn.started` over the whole log each time. Writing the
       settle back would make it irrevocable (#430 regression: legs and
       late-state turns never went live again). */
    const stopHelpers = (t: TurnModel): TurnModel =>
      t.subagents.some((sa) => sa.status === "running")
        ? {
            ...t,
            subagents: t.subagents.map((sa) =>
              sa.status === "running" ? { ...sa, status: "stopped" } : sa,
            ),
          }
        : t;
    const out: TurnModel[] = new Array(this.order.length);
    for (const [i, t] of this.order.entries()) {
      if (TERMINAL.has(t.phase)) {
        out[i] = settle === "stopped" ? stopHelpers(t) : t;
        continue;
      }
      const superseded =
        i < this.order.length - 1 ||
        (snapshotTurn !== undefined && snapshotTurn !== t.turnId);
      const phase = settle ?? (superseded ? ("done" as const) : undefined);
      if (!phase) {
        out[i] = settle === "stopped" ? stopHelpers(t) : t;
        continue;
      }
      const w: TurnModel = {
        ...t,
        phase,
        requests: t.requests.map((r) =>
          r.outcome === undefined ? { ...r, outcome: "cancel" } : r,
        ),
        steps: t.steps.map((s) =>
          s.status === "running" ? { ...s, status: "cancelled" } : s,
        ),
      };
      if (phase === "stopped") {
        w.plans = t.plans.map((p) => ({
          ...p,
          steps: p.steps.map((s) =>
            s.status === "pending" || s.status === "in_progress"
              ? { ...s, status: "cancelled" }
              : s,
          ),
        }));
      }
      out[i] = settle === "stopped" ? stopHelpers(w) : w;
    }

    const live = out.find((t) => !TERMINAL.has(t.phase));
    const openRequests: TurnRequest[] = [];
    /* #587 AC-2: helpers list ONLY on the Subagents tab (turn.subagents) —
       the Background/jobs row merge #309 added was the duplication bug. */
    for (const t of out) {
      for (const r of t.requests) {
        if (r.outcome === undefined) openRequests.push(r);
      }
    }
    /* Emit boundaries: the next batch clones fresh on first write —
       this emit's objects become immutable the moment they ship. */
    this.draftTurns.clear();
    this.draftJobs.clear();
    return {
      sessionId: this.sessionId,
      state,
      turns: out,
      live,
      openRequests,
      jobs: [...this.jobs.values()],
      model: this.model,
      provider: this.provider,
      effort: this.effort,
      fast: this.fast,
    };
  }
}

/**
 * Reduce one session's engine event log (+ optional snapshot) into turn
 * models for rendering. Pure and replay-safe: feed it the events.since log,
 * the session feed atom's events, or a live stream — same result.
 */
export function reduceSessionEvents(
  sessionId: string,
  events: EngineEvent[],
  snapshot?: ReduceSnapshot,
): SessionModel {
  return new SessionReducer(sessionId).apply(events, snapshot);
}
