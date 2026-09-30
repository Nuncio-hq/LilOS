import type {
  JobModel,
  SessionModel,
  SubagentModel,
  TurnModel,
  TurnPlan,
} from "@lilos/client-runtime";
import type {
  AppMessage,
  Ask,
  Conversation,
  Employee,
} from "@lilos/contracts/app";
import type {
  BackgroundJob,
  Msg,
  Phase,
  Reply,
  Step,
  Subagent,
  Thread,
  Employee as UiEmployee,
  Plan as UiPlan,
  Workspace,
} from "@lilos/ui/types";
import { toAttachedFiles } from "./attachments";

/** relay domain -> ui/domain type mapping (the only place it lives). */

/**
 * `engineDown` (#99): an employee can't answer while the engine is down, so
 * presence reads offline — never a green dot next to a red "Engine down".
 */
export function toUiEmployee(e: Employee, engineDown = false): UiEmployee {
  return {
    id: e.id,
    name: e.name,
    role: e.role,
    status: engineDown
      ? "offline"
      : e.status === "busy"
        ? "busy"
        : e.status === "offline"
          ? "offline"
          : "online",
    profile: e.profile,
    model: e.model,
    now: e.now,
    instructions: e.instructions,
    respondTo: e.respondTo,
  };
}

const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const PHASE_MAP: Record<TurnModel["phase"], Phase> = {
  submitted: "submitted",
  reasoning: "thinking",
  tools: "tools",
  text: "typing",
  waiting: "waiting",
  done: "done",
  stopped: "stopped",
};

/* #180: a turn's plan/task-list snapshot -> the ui Plan the PlanCard renders.
   A tasks list under 2 items is noise (issue default) and is never mapped. */
export function toUiPlan(p: TurnPlan): UiPlan | undefined {
  if (p.kind === "tasks" && p.steps.length < 2) return undefined;
  return {
    id: p.planId,
    kind: p.kind,
    version: p.version,
    ...(p.goal !== undefined ? { goal: p.goal } : {}),
    steps: p.steps.map((s) => ({
      text: s.text,
      ...(s.files ? { files: s.files } : {}),
      status: s.status,
    })),
    ...(p.risks ? { risks: p.risks } : {}),
    status: p.status,
  };
}

/** The turn's current plan: its latest snapshot entry (tasks or newest
    proposed version). Older superseded versions ride synthetic replies. */
function currentPlan(turn: TurnModel): UiPlan | undefined {
  const last = turn.plans.at(-1);
  return last ? toUiPlan(last) : undefined;
}

function toStep(s: TurnModel["steps"][number], turn?: TurnModel): Step {
  /* #309 AC-2: a delegate_task that closed on its dispatch receipt is not
     finished work — while the helper it spawned still runs the step reads
     "Dispatched", flipping to "Completed" when the engine settles it. */
  const dispatched =
    s.status !== "running" &&
    s.tool === "delegate_task" &&
    !!turn?.subagents.some(
      (sa) => sa.parentToolCallId === s.id && sa.status === "running",
    );
  return {
    tool: s.tool,
    input: s.input,
    output: s.output ?? "",
    running: s.status === "running",
    ...(dispatched ? { dispatched: true } : {}),
    diff: s.diff as Step["diff"],
    commit: s.commit as Step["commit"],
  };
}

/* ── #179: subagent + background-job model -> ui types ─────────────────── */

/** A helper row inside the turn's Subagents block. */
export function toSubagent(
  s: SubagentModel,
  resolveEmployee: (employeeRef: string) => string = (r) => r,
  turn?: TurnModel,
): Subagent {
  return {
    id: s.subagentId,
    name: s.name,
    task: s.task,
    status: s.status,
    steps: s.steps.map((x) => toStep(x, turn)),
    ...(s.result !== undefined ? { result: s.result } : {}),
    /* `Subagent.dur` reads seconds; the model tracks ms. */
    ...(s.durationMs !== undefined
      ? { dur: Math.round(s.durationMs / 10) / 100 }
      : {}),
    /* Another employee's helper links to its own session (D-#25): the
       engine reports its profile ref; the ui row needs the LilOS employee
       id (avatar + DM route), which `resolveEmployee` maps. */
    ...(s.employee
      ? {
          employee: {
            id: resolveEmployee(s.employee.employeeRef),
            session: s.employee.sessionRef,
          },
        }
      : {}),
  };
}

/** "38s" / "14m" / "1h 5m" — the Background tab's uptime column. */
export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** A session job row for Workbench → Background. `now` lets the caller pin
    one clock so a tick re-render doesn't jitter the uptime strings. */
export function toJob(j: JobModel, now = Date.now()): BackgroundJob {
  return {
    id: j.jobId,
    command: j.command,
    status: j.status,
    started: j.startedAt
      ? new Date(j.startedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })
      : "",
    uptime: j.startedAt
      ? formatUptime(((j.endedAt ?? now) - j.startedAt) / 1000)
      : "0s",
    ...(j.url ? { url: j.url } : {}),
    ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}),
    log: j.tail,
    ...(j.by ? { by: j.by } : {}),
    ...(j.subagent ? { subagent: true } : {}),
  };
}

/** A live engine turn rendered as the employee's in-progress reply. */
export function liveTurnReply(
  turn: TurnModel,
  employeeId: string,
  asks: Ask[] = [],
  resolveEmployee: (employeeRef: string) => string = (r) => r,
): Reply {
  // Approvals render from relay asks (the responder identity is the ask id);
  // turn.requests only mark the phase "waiting". An open ask wins; else the
  // turn's most recent resolved approval keeps its card (outcome label shows
  // via `resolved[ask.id]`).
  const approvals = asks.filter(
    (a) => a.turnId === turn.turnId && a.request.kind === "approval",
  );
  // An approval-blocked turn is phase "waiting" (the engine's
  // request.opened contract event); waitingOn carries the open request's
  // kind so the tool card can say "Waiting for approval" (issue #71, AC-4).
  const open = turn.requests.find((r) => r.outcome === undefined);
  const shown = approvals.find((a) => a.state === "open") ?? approvals.at(-1);
  const approval =
    shown && shown.request.kind === "approval"
      ? {
          id: shown.id,
          command: shown.request.command,
          note:
            shown.request.description ??
            "The employee is asking before it runs this.",
        }
      : undefined;
  return {
    id: `live-${turn.turnId}`,
    from: employeeId,
    time: "",
    text: turn.text,
    reasoning: turn.reasoning || undefined,
    steps: turn.steps.map((s) => toStep(s, turn)),
    steers: turn.steers,
    streaming: turn.phase === "text" ? turn.text : undefined,
    approval,
    model: turn.model,
    effort: turn.effort,
    fast: turn.fast,
    phase: PHASE_MAP[turn.phase],
    live: turn.phase !== "done" && turn.phase !== "stopped",
    plan: currentPlan(turn),
    waitingOn: turn.phase === "waiting" ? open?.request.kind : undefined,
    /* #179: helpers the turn delegated to (the Subagents block renders only
       when this is non-empty — the UI's own check). */
    ...(turn.subagents.length
      ? {
          subagents: turn.subagents.map((s) =>
            toSubagent(s, resolveEmployee, turn),
          ),
        }
      : {}),
  };
}

/* #180: a superseded plan version folds into its own employee reply
   ("Replaced by vN") right before the turn's card, like the prototype. */
function supersededPlanReplies(turn: TurnModel, employeeId: string): Reply[] {
  return turn.plans.slice(0, -1).flatMap((p) => {
    const plan = toUiPlan(p);
    return plan
      ? [
          {
            id: `${turn.turnId}-plan-${p.version}`,
            from: employeeId,
            time: "",
            text: "",
            plan,
          } satisfies Reply,
        ]
      : [];
  });
}

/** The live reply plus any superseded plan versions folded ahead of it. */
function liveReplies(
  turn: TurnModel,
  employeeId: string,
  asks: Ask[],
  resolveEmployee: (employeeRef: string) => string = (r) => r,
): Reply[] {
  return [
    ...supersededPlanReplies(turn, employeeId),
    liveTurnReply(turn, employeeId, asks, resolveEmployee),
  ];
}

/* AC-6 (D-#19): plan surfaces render only when the engine declares `plan` —
   drop plan cards and the empty synthetic rows that carried them. */
export function stripPlans(replies: Reply[]): Reply[] {
  return replies
    .map((r) => (r.plan ? { ...r, plan: undefined } : r))
    .filter(
      (r) =>
        !!(
          r.text ||
          r.reasoning ||
          r.streaming ||
          r.steps?.length ||
          r.steers?.length ||
          r.approval ||
          r.plan
        ),
    );
}

/** Relay channel messages for one conversation -> ui Reply[]. */
export function conversationReplies(
  messages: AppMessage[],
  conversationId: string,
): Reply[] {
  return (
    messages
      .filter((m) => m.conversationId === conversationId)
      // Older DBs may hold pre-#71 `⚙ …` tool-event system rows; the tool
      // cards inside the turn are the single rendering, so drop them (AC-1).
      .filter((m) => m.authorKind !== "system" || !m.text.startsWith("⚙"))
      .map((m) => ({
        id: m.id,
        from: m.authorKind === "system" ? "" : m.authorId,
        time: clock(m.createdAt),
        text: m.authorKind === "system" ? `⚠ ${m.text}` : m.text,
        model: m.model,
        effort: m.effort,
        fast: m.fast,
        phase: m.authorKind === "employee" ? "done" : undefined,
        attachments: toAttachedFiles(m.attachments),
      }))
  );
}

/**
 * Merge engine turns into the relay reply list: a turn whose text landed as
 * an employee message swaps into that slot (rich card: reasoning, steps,
 * approvals); turns not yet posted — and the live one — append at the end.
 * `rewound` (#134) describes a conversation's rewound tail. `refs` holds the
 * rewound message ids: a feed turn prompted by one (`turn.started.ref` =
 * its message id) would otherwise resurrect as an unmatched append even
 * though the relay thread dropped the tail. Turns the engine never tagged
 * (a steer pumped into a fresh turn on an engine that doesn't echo `ref`)
 * fall back to `texts` — the rewound employee answers' bodies.
 */
export function mergeTurns(
  replies: Reply[],
  model: SessionModel | undefined,
  employeeId: string,
  asks: Ask[] = [],
  rewound?: { refs?: ReadonlySet<string>; texts?: ReadonlySet<string> },
  resolveEmployee: (employeeRef: string) => string = (r) => r,
): Reply[] {
  if (!model) return replies;
  const used = new Set<TurnModel>();
  const flat: Reply[] = [];
  for (const r of replies) {
    const t = model.turns.find(
      (x) =>
        !used.has(x) &&
        r.from === employeeId &&
        x.text.trim() &&
        x.text.trim() === r.text.trim(),
    );
    if (!t) {
      flat.push(r);
      continue;
    }
    used.add(t);
    // Keep the relay message id — it's the search-hit scroll anchor (#138).
    const live = liveReplies(t, employeeId, asks, resolveEmployee);
    live[live.length - 1] = { ...live[live.length - 1], id: r.id };
    flat.push(...live);
  }
  /* A finished turn with no relay message (a stop before any text) sits
     right after the user message that prompted it (`turn.started.ref`), not
     at the end — appended, it jumped below every later message and answer.
     The live turn is always the newest, so it still goes last. */
  for (const t of model.turns) {
    if (used.has(t) || t === model.live) continue;
    /* `ref` is authoritative when the engine tagged the turn; steer-pumped
       turns without one match by their posted answer text instead. */
    if (t.ref ? rewound?.refs?.has(t.ref) : rewound?.texts?.has(t.text.trim()))
      continue;
    if (!t.text.trim() && t.phase !== "stopped") continue;
    const at = t.ref ? flat.findIndex((r) => r.id === t.ref) : -1;
    /* #288: a finished turn anchored to a message that renders nowhere is an
       orphan — e.g. a rebound engine session re-answering the root (the open
       thread renders the root as its header, not a reply row). Appending it
       would park the re-answer under the LATEST question. Stopped turns keep
       the tail append: their marker is the only surface of a stop on a
       root-anchored turn. Ref-less turns keep the tail fallback too: engines
       that never echo `ref` can't be positioned any other way. */
    if (t.ref && at < 0 && t.phase !== "stopped") continue;
    const rs = liveReplies(t, employeeId, asks, resolveEmployee);
    if (at < 0) flat.push(...rs);
    else flat.splice(at + 1, 0, ...rs);
  }
  if (model.live && !used.has(model.live))
    flat.push(...liveReplies(model.live, employeeId, asks, resolveEmployee));
  return flat;
}

/**
 * The context meter's usage pick (#300): the live session model's newest
 * turn wins; a dead engine session (legacy `s<N>` engineRefs the replay
 * degrades for) still carries the last persisted turn.completed on the
 * conversation row — the meter + ring render off `conv.usage` instead of
 * vanishing.
 */
export function threadUsage(
  model: SessionModel | undefined,
  conv: Conversation,
): Thread["usage"] {
  return model?.turns.at(-1)?.usage ?? conv.usage;
}

/**
 * The DM home feed: one Msg row per conversation (root user message). Pass
 * `mergeTurns` output as `replies` so engine turns show as rich cards.
 */
export function toFeed(
  root: AppMessage,
  conv: Conversation,
  replies: Reply[],
  /** Folder the session works in (#113) — feeds the row + header badges. */
  ws?: Workspace,
): Msg {
  return {
    kind: "msg",
    id: root.id,
    from: root.authorId,
    time: clock(root.createdAt),
    text: root.text,
    attachments: toAttachedFiles(root.attachments),
    thread: {
      session: conv.engineRef?.slice(0, 8) ?? conv.id.slice(0, 8),
      title: conv.title || undefined,
      archived: conv.archived,
      replies,
      ...(ws ? { ws } : {}),
    },
  };
}
