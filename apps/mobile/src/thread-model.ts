/* #157 — Turn projection for the mobile live thread: relay messages +
   engine events (reduceSessionEvents output) -> ui-native ThreadDetail.
   Pure functions; screens subscribe to RelayClient atoms and pass the latest
   values in. Mirrors apps/web/src/lib/mapping.ts mergeTurns onto
   ThreadEntry[] — same swap/append rules, phone-shaped rows. */

import type {
  JobModel,
  SessionModel,
  SubagentModel,
  TurnModel,
  TurnPlan,
  TurnStep,
} from "@lilos/client-runtime";
import type {
  AppMessage,
  Ask,
  Conversation,
  Employee,
} from "@lilos/contracts/app";
import type {
  AgentEntry,
  Approval,
  BackgroundJobRow,
  ModelRow,
  PlanRow,
  SubagentRow,
  ThreadDetail,
  ThreadEntry,
  ToolStep,
} from "@lilos/ui-native";
import {
  askReason,
  conversationState,
  folderLeaf,
  timeLabel,
} from "./dm-model";
import { toneOf } from "./mapping";

const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** The one argument worth showing on a step: a path, a command, a query. */
const argOf = (input: Record<string, unknown>): string | undefined => {
  const hit =
    input.command ?? input.path ?? input.query ?? input.pattern ?? input.url;
  if (typeof hit === "string" && hit) return hit;
  const first = Object.values(input).find((v) => typeof v === "string");
  return typeof first === "string" ? first : undefined;
};

export function toToolStep(s: TurnStep): ToolStep {
  return {
    id: s.id,
    tool: s.tool,
    arg: argOf(s.input),
    output: s.output,
    running: s.status === "running",
    add: s.diff?.add,
    del: s.diff?.del,
  };
}

/* #180: a tasks list under 2 items is noise and never maps (web rule). */
export function toPlanRow(p: TurnPlan): PlanRow | undefined {
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

/** `SubagentRow.dur` reads seconds; the model tracks ms. */
export function toSubagentRow(
  s: SubagentModel,
  resolveEmployee: (employeeRef: string) => string = (r) => r,
): SubagentRow {
  return {
    id: s.subagentId,
    name: s.name,
    task: s.task,
    status: s.status,
    steps: s.steps.map(toToolStep),
    ...(s.result !== undefined ? { result: s.result } : {}),
    ...(s.durationMs !== undefined
      ? { dur: Math.round(s.durationMs / 10) / 100 }
      : {}),
    /* Another employee's helper: the engine reports its profile ref; without
       a LilOS employee id the row renders neutral (name/task only). */
    ...(s.employee
      ? {
          employee: {
            id: resolveEmployee(s.employee.employeeRef),
            name: resolveEmployee(s.employee.employeeRef),
            tone: "stone" as const,
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

export function toJobRow(j: JobModel, now = Date.now()): BackgroundJobRow {
  return {
    id: j.jobId,
    command: j.command,
    status: j.status,
    started: j.startedAt ? clock(j.startedAt) : "",
    uptime: j.startedAt ? formatUptime((now - j.startedAt) / 1000) : "0s",
    ...(j.url ? { url: j.url } : {}),
    ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}),
    log: j.tail,
    ...(j.by ? { by: j.by } : {}),
  };
}

/** "22.4k in · 1.8k out · 15k cached" — the session sheet's usage row. */
export function usageLabel(u: {
  input: number;
  output: number;
  reasoning?: number;
  cache?: number;
}): string {
  const k = (n: number) =>
    n < 1000 ? `${n}` : `${Math.round((n / 1000) * 10) / 10}k`;
  const bits = [`${k(u.input)} in`, `${k(u.output + (u.reasoning ?? 0))} out`];
  if (u.cache) bits.push(`${k(u.cache)} cached`);
  return bits.join(" · ");
}

/** Ask -> the approval card (or the after-you-chose receipt). */
function turnApproval(
  turn: TurnModel,
  asks: readonly Ask[],
  meta: { employeeId: string; employee: string; session: string },
  now: number,
): { approval?: Approval; decided?: AgentEntry["decided"] } {
  const list = asks.filter((a) => a.turnId === turn.turnId);
  const open = list.find((a) => a.state === "open");
  if (open) {
    return {
      approval: {
        id: open.id,
        employeeId: meta.employeeId,
        employee: meta.employee,
        tone: toneOf(meta.employeeId),
        session: meta.session,
        reason: askReason(open),
        command:
          open.request.kind === "approval" ? open.request.command : undefined,
        age: timeLabel(open.createdAt, now),
      },
    };
  }
  const resolved = list.at(-1);
  return resolved
    ? {
        decided: {
          approved:
            resolved.outcome === "once" ||
            resolved.outcome === "always" ||
            resolved.outcome === "approve" ||
            resolved.outcome === "answer",
          what: askReason(resolved),
        },
      }
    : {};
}

/** TurnModel -> the AgentEntry the thread renders (live or finished). */
export function toAgentEntry(
  turn: TurnModel,
  opts: {
    /** Wall-clock time on the row (the reply message's time once posted). */
    time: string;
    /** "Worked for Ns" — only a finished turn with a posted reply has one. */
    dur?: number;
    asks: readonly Ask[];
    employeeId: string;
    employeeName: string;
    sessionId: string;
    now: number;
  },
): AgentEntry {
  const live = turn.phase !== "done" && turn.phase !== "stopped";
  const lastPlan = turn.plans.at(-1);
  const stopped = turn.phase === "stopped";
  const files = new Set(
    turn.steps.flatMap((s) => (s.diff ? [s.diff.path] : [])),
  ).size;
  return {
    kind: "agent",
    id: `turn-${turn.turnId}`,
    time: opts.time,
    reasoning: turn.reasoning || undefined,
    steps: turn.steps.map(toToolStep),
    text: turn.text,
    live,
    stopped,
    writing: turn.phase === "text",
    ...turnApproval(
      turn,
      opts.asks,
      {
        employeeId: opts.employeeId,
        employee: opts.employeeName,
        session: opts.sessionId,
      },
      opts.now,
    ),
    plan: lastPlan ? toPlanRow(lastPlan) : undefined,
    ...(turn.subagents.length
      ? { subagents: turn.subagents.map((s) => toSubagentRow(s)) }
      : {}),
    footer:
      !live && (opts.dur !== undefined || turn.model)
        ? {
            ...(opts.dur !== undefined ? { dur: opts.dur } : {}),
            model: turn.model,
            effort: turn.effort,
            files: files || undefined,
          }
        : undefined,
  };
}

/**
 * Merge engine turns into the relay message list (the web `mergeTurns`
 * port): a turn whose text landed as an employee message swaps into that
 * slot as a rich card; turns not yet posted — and the live one — append at
 * the end. `rewound` (#134): refs/texts hide rewound-tail turns.
 */
export function mergeThreadEntries(
  messages: readonly AppMessage[],
  model: SessionModel | undefined,
  opts: {
    conversationId: string;
    /** conv.deliveredSeq — user messages past it show "Queued · runs next". */
    deliveredSeq?: number;
    asks: readonly Ask[];
    employeeId: string;
    employeeName: string;
    sessionId?: string;
    rewoundRefs?: ReadonlySet<string>;
    rewoundTexts?: ReadonlySet<string>;
    now: number;
  },
): ThreadEntry[] {
  const entries: ThreadEntry[] = messages.map((m) =>
    m.authorKind === "user"
      ? {
          kind: "user",
          id: m.id,
          time: clock(m.createdAt),
          text: m.text,
          ...(opts.deliveredSeq !== undefined && m.seq > opts.deliveredSeq
            ? { queued: true }
            : {}),
        }
      : {
          kind: "agent",
          id: m.id,
          time: clock(m.createdAt),
          text: m.authorKind === "system" ? `⚠ ${m.text}` : m.text,
        },
  );

  if (!model) return entries;

  /* A finished turn lands where its reply message sits: match on the exact
     text the engine posted (stripMessages on web; relays keep full text). */
  const byText = new Map<string, TurnModel>();
  for (const t of model.turns) {
    const text = t.text.trim();
    if (text && !byText.has(text)) byText.set(text, t);
  }
  const swapped = new Set<string>();
  for (const m of messages) {
    if (m.authorKind !== "employee") continue;
    const turn = byText.get(m.text.trim());
    if (!turn) continue;
    swapped.add(turn.turnId);
    const idx = entries.findIndex((e) => e.id === m.id);
    /* dur = prompt -> reply latency, the only honest wall-clock available. */
    const prompt = turn.ref
      ? messages.find((x) => x.id === turn.ref)
      : undefined;
    const dur = prompt
      ? Math.max(0, Math.round((m.createdAt - prompt.createdAt) / 1000))
      : undefined;
    const entry = toAgentEntry(turn, {
      time: clock(m.createdAt),
      dur,
      asks: opts.asks,
      employeeId: opts.employeeId,
      employeeName: opts.employeeName,
      sessionId: opts.sessionId ?? model.sessionId,
      now: opts.now,
    });
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
  }

  /* Unmatched turns: finished ones slot after their `ref` message (the
     prompt that started them); the live turn goes last. Rewound turns —
     those the rewind dropped — never resurrect (refs = their prompt's id,
     texts = the dropped answers' bodies). */
  const leftover = model.turns.filter((t) => {
    if (swapped.has(t.turnId)) return false;
    if (opts.rewoundRefs?.has(t.ref ?? "")) return false;
    const text = t.text.trim();
    if (text && opts.rewoundTexts?.has(text)) return false;
    return true;
  });
  const entryFor = (t: TurnModel) =>
    toAgentEntry(t, {
      time: "",
      asks: opts.asks,
      employeeId: opts.employeeId,
      employeeName: opts.employeeName,
      sessionId: opts.sessionId ?? model.sessionId,
      now: opts.now,
    });
  const byRef = new Map<string, number>();
  for (const [i, e] of entries.entries()) byRef.set(e.id, i);
  let insertAt = entries.length;
  for (const t of leftover) {
    if (t === model.live) continue;
    const refIdx = t.ref ? byRef.get(t.ref) : undefined;
    if (refIdx === undefined) {
      entries.push(entryFor(t));
    } else {
      entries.splice(refIdx + 1, 0, entryFor(t));
    }
    insertAt = entries.length;
  }
  if (model.live) {
    entries.splice(insertAt, 0, entryFor(model.live));
  }
  return entries;
}

/** Conversation + session model -> the whole ThreadScreen view model. */
export function toThreadDetail(opts: {
  conversation: Conversation;
  employee?: Employee;
  messages: readonly AppMessage[];
  model?: SessionModel;
  asks: readonly Ask[];
  pending: ReadonlySet<string>;
  now: number;
  /** Catalog models for the sheet's Model row label. */
  models?: readonly ModelRow[];
}): ThreadDetail {
  const { conversation: conv } = opts;
  const employee = opts.employee;
  const employeeName = employee?.name ?? conv.channelId;
  const empId = employee?.id ?? conv.channelId;
  const last = opts.messages.at(-1);
  const sessionModel = opts.model;
  const pick = opts.models?.find(
    (m) => m.id === (conv.model ?? sessionModel?.model),
  );
  /* #134: rewound rows hide from the thread; their ids/bodies also hide the
     turns they prompted/answered (never resurrect a rewound turn). */
  const rewound = opts.messages.filter((m) => m.rewound);
  const entries = mergeThreadEntries(
    opts.messages.filter((m) => !m.rewound),
    sessionModel,
    {
      conversationId: conv.id,
      deliveredSeq: conv.deliveredSeq,
      asks: opts.asks,
      employeeId: empId,
      employeeName,
      sessionId: conv.engineRef ?? undefined,
      rewoundRefs: new Set(rewound.map((m) => m.id)),
      rewoundTexts: new Set(
        rewound
          .filter((m) => m.authorKind === "employee")
          .map((m) => m.text.trim()),
      ),
      now: opts.now,
    },
  );
  const usage = sessionModel?.turns.reduce(
    (acc, t) =>
      t.usage
        ? {
            input: acc.input + t.usage.input,
            output: acc.output + t.usage.output,
            reasoning: (acc.reasoning ?? 0) + (t.usage.reasoning ?? 0),
            cache: (acc.cache ?? 0) + (t.usage.cache ?? 0),
          }
        : acc,
    { input: 0, output: 0, reasoning: 0, cache: 0 },
  );
  return {
    id: conv.id,
    title: conv.title || opts.messages[0]?.text || "",
    state: conversationState(conv, {
      openAsks: [...opts.asks],
      pending: opts.pending,
    }),
    employee: { id: empId, name: employeeName, tone: toneOf(empId) },
    when: last ? timeLabel(last.createdAt, opts.now) : "now",
    started: conv.createdAt
      ? new Date(conv.createdAt).toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "",
    /* The Folder row shows the picked folder (repoPath on a workstream —
       the worktree path in cwd is #156 plumbing, not the picked folder). */
    folder:
      (conv.workspace?.repoPath ?? conv.cwd)
        ? {
            name: folderLeaf(conv.workspace?.repoPath ?? conv.cwd ?? ""),
            path: conv.workspace?.repoPath ?? conv.cwd ?? "",
          }
        : undefined,
    branch: conv.workspace
      ? {
          name: conv.workspace.branch,
          detail:
            conv.workspace.mode === "new"
              ? `off ${conv.workspace.base} in ${conv.cwd ?? ""}`
              : `in ${conv.cwd ?? ""}`,
        }
      : undefined,
    model: pick?.name ?? conv.model ?? sessionModel?.model ?? "",
    session: conv.engineRef ?? "",
    usage:
      usage && (usage.input || usage.output) ? usageLabel(usage) : undefined,
    jobs: sessionModel?.jobs.map((j) => toJobRow(j, opts.now)),
    entries,
  };
}
