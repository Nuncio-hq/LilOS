/* #157 — Turn projection for the mobile live thread: relay messages +
   engine events (reduceSessionEvents output) -> ui-native ThreadDetail.
   Pure functions; screens subscribe to RelayClient atoms and pass the latest
   values in. Mirrors apps/web/src/lib/mapping.ts mergeTurns onto
   ThreadEntry[] — same swap/append rules, phone-shaped rows. */

import type { JobModel, SessionModel, TurnModel } from "@lilos/client-runtime";
import type {
  AppMessage,
  Ask,
  Conversation,
  Employee,
} from "@lilos/contracts/app";
import type { Job } from "@lilos/contracts/engine";
import type {
  AgentEntry,
  Approval,
  ModelRow,
  PullRequestRef,
  SubagentRow,
  ThreadDetail,
  ThreadEntry,
} from "@lilos/ui-native";
import { contextWindowOf } from "@lilos/ui-native/model-rules";
import {
  askReason,
  conversationState,
  folderLeaf,
  timeLabel,
} from "./dm-model";
import { toneOf } from "./mapping";
import {
  listedJobModel,
  toJobRow,
  toPlanRow,
  toSubagentRow,
  toToolStep,
  usageLabel,
} from "./thread-rows";

/** #181: engine `employeeRef`/`sessionRef` -> the row's employee + thread
   link. The default keeps refs as plain labels (unknown profiles, the
   helper's DM not yet seen). */
type ResolveEmployee = (link: {
  employeeRef: string;
  sessionRef: string;
}) => SubagentRow["employee"];

const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Ask -> the approval card (or the after-you-chose receipt). A `plan` ask
    never lands here — the Plan card is that ask's own surface (#182). */
function turnApproval(
  turn: TurnModel,
  asks: readonly Ask[],
  meta: { employeeId: string; employee: string; session: string },
  now: number,
): { approval?: Approval; decided?: AgentEntry["decided"] } {
  const list = asks.filter(
    (a) => a.turnId === turn.turnId && a.request.kind !== "plan",
  );
  const open = list.find((a) => a.state === "open");
  if (open) {
    return {
      approval: {
        id: open.id,
        employeeId: meta.employeeId,
        employee: meta.employee,
        tone: toneOf(meta.employeeId),
        session: meta.session,
        kind: open.request.kind,
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
    /** The engine declared `plan` (D-#19) — plan rows render only then. */
    planCapable?: boolean;
    /** Resolves an employee helper's refs to its row link (#181). */
    resolveEmployee?: ResolveEmployee;
    /** The conversation's PRs (#159) — a finished turn that ran
       `gh pr create` gets the PR card under its reply (web: PrCard). */
    prs?: readonly PullRequestRef[];
    /** Measured seconds the turn spent reasoning (#327) — feeds the
       "Thought for Ns" label; absent on replayed turns (no wire
       timestamps), which fall back to "Thought". */
    thought?: number;
    /** Relay conversation state said a turn can run (#327): when the
       conversation is not active no turn renders live — the engine's
       view settled before its events reached the client. */
    sessionRunning?: boolean;
    now: number;
  },
): AgentEntry {
  const live =
    turn.phase !== "done" &&
    turn.phase !== "stopped" &&
    opts.sessionRunning !== false;
  /* The PR card under the reply (web: PrCard): the turn must have run
     `gh pr create`; the card is the PR the step's output URL names
     ("…/pull/N") — the conversation's top PR when it didn't (same rule as
     web's branch-HEAD lookup). */
  const prStep = turn.steps.findLast((s) =>
    String(s.input.command ?? "").startsWith("gh pr create"),
  );
  const createdNumber = prStep?.output?.match(/\/pull\/(\d+)/)?.[1];
  const openedPr =
    !live && opts.prs?.length && prStep
      ? (opts.prs.find((p) => p.number === Number(createdNumber)) ??
        opts.prs[0])
      : undefined;
  const lastPlan = opts.planCapable === false ? undefined : turn.plans.at(-1);
  const stopped = turn.phase === "stopped";
  const files = new Set(
    turn.steps.flatMap((s) => (s.diff ? [s.diff.path] : [])),
  ).size;
  const { approval, decided } = turnApproval(
    turn,
    opts.asks,
    {
      employeeId: opts.employeeId,
      employee: opts.employeeName,
      session: opts.sessionId,
    },
    opts.now,
  );
  const plan = lastPlan ? toPlanRow(lastPlan) : undefined;
  /* #264: a live turn with an open ask is blocked on the user, not running —
     every turn surface reads from this one flag instead of showing a live
     dot / "Running" / "Thinking…" while the ask waits. */
  const waiting = live
    ? (approval?.kind ?? (plan?.status === "proposed" ? "plan" : undefined))
    : undefined;
  return {
    kind: "agent",
    id: `turn-${turn.turnId}`,
    time: opts.time,
    reasoning: turn.reasoning || undefined,
    ...(opts.thought !== undefined ? { thought: opts.thought } : {}),
    /* #327: thinking mirrors web's `live && phase === "thinking"` — a
       turn past its reasoning phase (tools/text/waiting) collapses to
       "Thought for Ns" even while it keeps running, and a settled turn
       never reads "Thinking…". */
    thinking: live && turn.phase === "reasoning",
    steps: turn.steps.map((s) => toToolStep(s, turn)),
    text: turn.text,
    live,
    waiting,
    stopped,
    ...(turn.agentInitiated ? { agentInitiated: true } : {}),
    writing: turn.phase === "text",
    approval,
    decided,
    plan,
    ...(turn.subagents.length
      ? {
          subagents: turn.subagents.map((s) =>
            toSubagentRow(s, opts.resolveEmployee, turn),
          ),
        }
      : {}),
    ...(openedPr ? { pr: openedPr } : {}),
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

/* #182: every plan version before the latest renders as its own folded
   card ahead of the turn — the web supersededPlanReplies rule. The newest
   stays on the turn's card itself. */
function supersededPlanEntries(
  turn: TurnModel,
  planCapable: boolean | undefined,
): AgentEntry[] {
  if (planCapable === false) return [];
  return turn.plans.slice(0, -1).flatMap((p) => {
    const plan = toPlanRow(p);
    if (!plan) return [];
    return [
      {
        kind: "agent" as const,
        id: `turn-${turn.turnId}-plan-v${plan.version}`,
        time: "",
        text: "",
        steps: [],
        live: false,
        plan,
      },
    ];
  });
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
    /** The engine declared `plan` (D-#19); false strips every plan row. */
    planCapable?: boolean;
    /** Resolves an employee helper's refs to its row link (#181). */
    resolveEmployee?: ResolveEmployee;
    /** The conversation's PRs (#159) — passed to turns that opened one. */
    prs?: readonly PullRequestRef[];
    rewoundRefs?: ReadonlySet<string>;
    rewoundTexts?: ReadonlySet<string>;
    /** The relay conversation's state (#327): anything but "active" means
       no turn can still be running — a stale engine feed can't keep a
       card live behind the relay's own word. */
    conversationState?: Conversation["state"];
    /** Per-turn measured reasoning seconds (#327) — see toAgentEntry. */
    thoughts?: ReadonlyMap<string, number>;
    now: number;
  },
): ThreadEntry[] {
  /* #264: an open ask anywhere in the conversation blocks every queued
     message — "Queued · runs next" is stale while the turn waits on you. */
  const blocked = opts.asks.some(
    (a) => a.state === "open" && a.conversationId === opts.conversationId,
  );
  const entries: ThreadEntry[] = messages.map((m) =>
    m.authorKind === "user"
      ? {
          kind: "user",
          id: m.id,
          time: clock(m.createdAt),
          text: m.text,
          ...(opts.deliveredSeq !== undefined && m.seq > opts.deliveredSeq
            ? { queued: true, ...(blocked ? { waiting: true } : {}) }
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

  /* #327: the relay conversation's own word on whether a turn can run —
     a non-"active" state clamps model.live (and every entry's `live`
     flag through toAgentEntry) the same way the engine-state settle
     inside reduceSessionEvents does for the feed side. */
  const sessionRunning =
    opts.conversationState === undefined || opts.conversationState === "active";
  const liveTurn = sessionRunning ? model.live : undefined;

  /* A finished turn lands where its reply message sits: match on the exact
     text the engine posted (stripMessages on web; relays keep full text).
     Each turn claims ONE message in turn order — an engine that answers two
     turns with the same text (canned replies repeat across sessions, #181)
     must not stamp the same rich card on both rows. And the claim is
     position-bounded: a turn only matches a message AFTER its `ref` prompt —
     without it, a rebound session's turn (turn ids restart per session)
     steals an older session's identical reply and shows the wrong card
     (phantom subagents + a bogus duration, #181 AC-4). A settled turn
     (done/stopped) only — a live turn's streamed text can already equal
     the posted reply while the relay event that settles it is still
     queued, and claiming it would render its card twice under the same
     `turn-tN` key (once at the message, once at the tail). */
  const promptIdx = new Map<TurnModel, number>();
  for (const t of model.turns) {
    if (!t.ref) continue;
    const i = messages.findIndex((x) => x.id === t.ref);
    if (i >= 0) promptIdx.set(t, i);
  }
  const used = new Set<TurnModel>();
  /* Newest row a leg claimed (#308) — the pass-2 cursor below. */
  let legClaimed = -1;
  /* dur = prompt -> reply latency, the only honest wall-clock available. */
  const claimedEntry = (t: TurnModel, m: AppMessage) => {
    const prompt = t.ref ? messages.find((x) => x.id === t.ref) : undefined;
    const dur = prompt
      ? Math.max(0, Math.round((m.createdAt - prompt.createdAt) / 1000))
      : undefined;
    return toAgentEntry(t, {
      time: clock(m.createdAt),
      dur,
      asks: opts.asks,
      employeeId: opts.employeeId,
      employeeName: opts.employeeName,
      sessionId: opts.sessionId ?? model.sessionId,
      planCapable: opts.planCapable,
      resolveEmployee: opts.resolveEmployee,
      prs: opts.prs,
      thought: opts.thoughts?.get(t.turnId),
      sessionRunning,
      now: opts.now,
    });
  };
  for (const [mi, m] of messages.entries()) {
    if (m.authorKind !== "employee") continue;
    const turn = model.turns.find(
      (x) =>
        !used.has(x) &&
        !x.agentInitiated &&
        (x.phase === "done" || x.phase === "stopped") &&
        x.text.trim() &&
        x.text.trim() === m.text.trim() &&
        (promptIdx.get(x) ?? -1) < mi,
    );
    if (!turn) continue;
    used.add(turn);
    const idx = entries.findIndex((e) => e.id === m.id);
    const entry = claimedEntry(turn, m);
    const superseded = supersededPlanEntries(turn, opts.planCapable);
    if (idx >= 0) entries.splice(idx, 1, ...superseded, entry);
    else entries.push(...superseded, entry);
  }
  /* #308: a finished agent leg's text also posts to the relay as a plain
     employee row (harness finishTurn, no ref correlation) — claim it into
     the leg's card or the same answer renders twice. Claimed rows were
     already spliced into their turn's entry, so `entries.some` alone
     keeps a leg from stealing a claimed answer; the legClaimed cursor
     pairs same-text legs with their posts in order. */
  for (const t of model.turns) {
    if (
      !t.agentInitiated ||
      used.has(t) ||
      (t.phase !== "done" && t.phase !== "stopped") ||
      !t.text.trim()
    )
      continue;
    let mi = -1;
    for (let i = legClaimed + 1; i < messages.length; i++) {
      const m = messages[i];
      if (
        m.authorKind === "employee" &&
        m.text.trim() === t.text.trim() &&
        entries.some((e) => e.id === m.id)
      ) {
        mi = i;
        break;
      }
    }
    if (mi < 0) continue;
    used.add(t);
    legClaimed = mi;
    const m = messages[mi];
    const idx = entries.findIndex((e) => e.id === m.id);
    const entry = claimedEntry(t, m);
    const superseded = supersededPlanEntries(t, opts.planCapable);
    if (idx >= 0) entries.splice(idx, 1, ...superseded, entry);
    else entries.push(...superseded, entry);
  }

  /* Unmatched turns: finished ones slot after their `ref` message (the
     prompt that started them); the live turn goes last. Rewound turns —
     those the rewind dropped — never resurrect. Web rule: the ref check
     wins; a turn with no ref falls back to matching the dropped answer's
     body, so a legit turn quoting a rewound answer survives. */
  const leftover = model.turns.filter((t) => {
    if (used.has(t)) return false;
    const text = t.text.trim();
    /* A finished turn with no content renders a bare card — drop it unless
       it was stopped mid-flight (the "You stopped this turn" row is the
       receipt). Same rule as web's mergeTurns; a text-less turn that did
       work (steps/subagents/plan/reasoning) still has rows to show. */
    const empty =
      !text &&
      !t.steps.length &&
      !t.reasoning &&
      !t.subagents.length &&
      !t.plans.length;
    if (empty && t.phase !== "stopped" && t !== liveTurn) return false;
    const wasRewound = t.ref
      ? (opts.rewoundRefs?.has(t.ref) ?? false)
      : text.length > 0 && (opts.rewoundTexts?.has(text) ?? false);
    if (wasRewound) return false;
    return true;
  });
  const entryFor = (t: TurnModel) =>
    toAgentEntry(t, {
      time: "",
      asks: opts.asks,
      employeeId: opts.employeeId,
      employeeName: opts.employeeName,
      sessionId: opts.sessionId ?? model.sessionId,
      planCapable: opts.planCapable,
      resolveEmployee: opts.resolveEmployee,
      prs: opts.prs,
      thought: opts.thoughts?.get(t.turnId),
      sessionRunning,
      now: opts.now,
    });
  /* #308: a claimed turn anchored by `ref` re-anchors under the message
     that prompted it — its answer's row can arrive after a newer prompt
     and must not park there. The card's plan-superseded rows travel with
     it. Claimed-but-anchorless turns keep the claimed slot (the claim is
     its own correlation, #288). Landing under a prompt never leapfrogs
     turn cards already there — they hold the slot by the same rule. */
  const skipTurnRun = (i: number) => {
    let at = i;
    while (at < entries.length && entries[at].id.startsWith("turn-")) at++;
    return at;
  };
  for (const t of model.turns) {
    if (!used.has(t) || !t.ref) continue;
    const cardId = `turn-${t.turnId}`;
    const cardAt = entries.findIndex((e) => e.id === cardId);
    const refAt = entries.findIndex((e) => e.id === t.ref);
    if (cardAt < 0 || refAt < 0 || refAt + 1 === cardAt) continue;
    /* Already inside the anchored run right after its prompt — the run
       holds same-ref turns in order, so leave it. */
    let inRun = refAt + 1;
    while (inRun < cardAt && entries[inRun].id.startsWith("turn-")) inRun++;
    if (inRun === cardAt) continue;
    let runStart = cardAt;
    while (
      runStart > 0 &&
      entries[runStart - 1].id.startsWith(`${cardId}-plan-`)
    )
      runStart--;
    const run = entries.splice(runStart, cardAt - runStart + 1);
    entries.splice(
      skipTurnRun(entries.findIndex((e) => e.id === t.ref) + 1),
      0,
      ...run,
    );
  }

  const byRef = new Map<string, number>();
  for (const [i, e] of entries.entries()) byRef.set(e.id, i);
  /* Two leftover turns can share one ref; each lands after the previous so
     they keep turn order instead of stacking in reverse. */
  const insertAfter = new Map<string, number>();
  for (const t of leftover) {
    if (t === liveTurn) continue;
    const refIdx = t.ref
      ? (insertAfter.get(t.ref) ?? byRef.get(t.ref))
      : undefined;
    const superseded = supersededPlanEntries(t, opts.planCapable);
    if (refIdx === undefined) {
      entries.push(...superseded, entryFor(t));
    } else {
      const dest = skipTurnRun(refIdx + 1);
      entries.splice(dest, 0, ...superseded, entryFor(t));
      if (t.ref) insertAfter.set(t.ref, dest + superseded.length);
    }
  }
  /* The live turn anchors under its prompting message like a posted one
     (#308) — a newer question must not push it below itself at the tail.
     byRef is stale past the leftover splices, so look the row up fresh. */
  if (liveTurn) {
    const rows = [
      ...supersededPlanEntries(liveTurn, opts.planCapable),
      entryFor(liveTurn),
    ];
    const refAt = liveTurn.ref
      ? entries.findIndex((e) => e.id === liveTurn?.ref)
      : -1;
    if (refAt < 0) entries.push(...rows);
    else entries.splice(skipTurnRun(refAt + 1), 0, ...rows);
  }
  /* #308 AC-3: an agent-initiated leg sits right after the previous
     turn's card — a user message that landed while it worked never
     renders above it (same slot rule as web's mergeTurns). Applies to
     claimed legs (their relay row lands at the tail), unposted leftovers
     and the live leg alike; ref'd steer legs keep their prompt anchor. */
  let prevEnd = 0;
  for (const t of model.turns) {
    const cardId = `turn-${t.turnId}`;
    const at = entries.findIndex((e) => e.id === cardId);
    if (at < 0) continue;
    let runStart = at;
    while (
      runStart > 0 &&
      entries[runStart - 1].id.startsWith(`${cardId}-plan-`)
    )
      runStart--;
    const runLen = at - runStart + 1;
    if (t.agentInitiated && !t.ref) {
      let dest = Math.min(prevEnd, entries.length);
      if (runStart < dest) dest -= runLen;
      if (dest !== runStart) {
        const run = entries.splice(runStart, runLen);
        entries.splice(dest, 0, ...run);
      }
      prevEnd = dest + runLen;
    } else prevEnd = at + 1;
  }
  return entries;
}

/** A conversation's rewind record (client.rewinds) — #134. */
export interface RewindRecord {
  fromSeq: number;
  removedIds: readonly string[];
}

/** #134: drop the rewound tail from a fetched message list. The channel
   atoms already strip it server-side on conversation.rewound, but a
   messages.list snapshot held by the screen does not — apply the same
   predicate (removed ids + channel seq >= fromSeq) so a live rewind
   disappears without a reopen. The removed rows come back too, so the
   caller can hide the turns they prompted/answered. */
export function dropRewound(
  messages: readonly AppMessage[],
  rewind?: RewindRecord,
): { messages: AppMessage[]; removed: AppMessage[] } {
  if (!rewind) return { messages: [...messages], removed: [] };
  const ids = new Set(rewind.removedIds);
  const dropped = (m: AppMessage) => ids.has(m.id) || m.seq >= rewind.fromSeq;
  return {
    messages: messages.filter((m) => !dropped(m)),
    removed: messages.filter(dropped),
  };
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
  /** Rewound prompt ids + removed answer bodies (from dropRewound), so the
     turns they spawned stay hidden once the messages are gone. */
  rewound?: {
    refs: ReadonlySet<string>;
    texts: ReadonlySet<string>;
  };
  /** The engine declared `plan` (D-#19) — pass false to strip plan rows. */
  planCapable?: boolean;
  /* #181: helper resolution needs the directory (profile ref -> employee)
     and the session index (sessionRef -> the conversation to open). */
  employees?: readonly Employee[];
  conversations?: readonly Conversation[];
  /** The engine declared `background_jobs` (D-#19): without it no pill,
     sheet or job rows render — and `jobs.list` is never asked. */
  jobsCapable?: boolean;
  /** `jobs.list` rows for this session — they cover jobs the event stream
     can't (started before a harness restart); job.* events overlay them. */
  listedJobs?: readonly Job[];
  /** The thread's PRs (#159) — header headline + Session sheet group. */
  prs?: readonly PullRequestRef[];
  /** Per-turn measured reasoning seconds (#327) — live-measured by the
     screen; replayed turns have none and fall back to "Thought". */
  thoughts?: ReadonlyMap<string, number>;
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
     turns they prompted/answered (never resurrect a rewound turn). Two
     sources: rows still flagged rewound on the wire, and the rewind record
     the screen already applied to its fetched history (ids + the removed
     answers' bodies it captured before dropping them). */
  const flagged = opts.messages.filter((m) => m.rewound);
  const rewoundRefs = new Set<string>([
    ...flagged.map((m) => m.id),
    ...(opts.rewound?.refs ?? []),
  ]);
  const rewoundTexts = new Set<string>([
    ...flagged
      .filter((m) => m.authorKind === "employee")
      .map((m) => m.text.trim()),
    ...(opts.rewound?.texts ?? []),
  ]);
  /* #181 AC-2: a helper that is another employee links to their DM thread —
     the engine's profile ref -> Employee.profile, its sessionRef -> the
     conversation bound to that session. */
  const resolveEmployee: ResolveEmployee = ({ employeeRef, sessionRef }) => {
    const emp = opts.employees?.find((e) => e.profile === employeeRef);
    const id = emp?.id ?? employeeRef;
    const thread = opts.conversations?.find((c) => c.engineRef === sessionRef);
    return {
      id,
      name: emp?.name ?? employeeRef,
      tone: toneOf(id),
      ...(thread ? { threadId: thread.id } : {}),
    };
  };
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
      planCapable: opts.planCapable,
      resolveEmployee,
      prs: opts.prs,
      rewoundRefs,
      rewoundTexts,
      conversationState: conv.state,
      thoughts: opts.thoughts,
      now: opts.now,
    },
  );
  /* #181: the session's background processes — `jobs.list` rows fill the
     engine-restart gap first; event-derived rows overwrite by jobId
     (fresher). Nothing lists without `background_jobs` (AC-5). */
  const jobsById = new Map<string, JobModel>();
  if (opts.jobsCapable) {
    for (const j of opts.listedJobs ?? [])
      jobsById.set(j.jobId, listedJobModel(j));
    for (const j of sessionModel?.jobs ?? []) jobsById.set(j.jobId, j);
  }
  /* #309: delegated helpers row up here too — `subagents`, not
     `background_jobs`, so they merge outside the capability gate. */
  for (const j of sessionModel?.subagentJobs ?? []) jobsById.set(j.jobId, j);
  const jobs = jobsById.size
    ? [...jobsById.values()].map((j) => toJobRow(j, opts.now))
    : undefined;
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
  /* #247: the ring + Session-info meter read the newest turn's cumulative
     usage — the same pick the web thread panel makes (#294). Its window
     resolves through the shared rules: the engine's report first, the
     catalog row, then the ~-labelled estimate. #300: a dead engine session
     (legacy engineRef, degraded empty replay) keeps the meter off the
     conversation's persisted last turn.completed. */
  const ctxUsage = sessionModel?.turns.at(-1)?.usage ?? conv.usage;
  const ctxWindow = contextWindowOf(
    ctxUsage,
    conv.model ?? sessionModel?.model,
    opts.models,
  );
  return {
    id: conv.id,
    title: conv.title || opts.messages[0]?.text || "",
    state: conversationState(conv, {
      openAsks: [...opts.asks],
      pending: opts.pending,
    }),
    ...(sessionModel?.live?.agentInitiated ? { agentWorking: true } : {}),
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
      usage && (usage.input || usage.output)
        ? usageLabel(usage)
        : conv.usage
          ? usageLabel(conv.usage)
          : undefined,
    ...(ctxUsage
      ? {
          context: {
            input: ctxUsage.input,
            output: ctxUsage.output,
            reasoning: ctxUsage.reasoning ?? 0,
            cache: ctxUsage.cache ?? 0,
            max: ctxWindow.tokens,
            estimated: ctxWindow.estimated,
          },
        }
      : {}),
    jobs,
    ...(opts.prs?.length ? { prs: [...opts.prs] } : {}),
    entries,
  };
}
