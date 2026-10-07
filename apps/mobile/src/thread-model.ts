/* #157 — Turn projection for the mobile live thread: relay messages +
   engine events (reduceSessionEvents output) -> ui-native ThreadDetail.
   Pure functions; screens subscribe to RelayClient atoms and pass the latest
   values in. Mirrors apps/web/src/lib/mapping.ts mergeTurns onto
   ThreadEntry[] — same swap/append rules, phone-shaped rows. */

import type {
  JobModel,
  SessionModel,
  TurnModel,
  TurnStep,
} from "@lilos/client-runtime";
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
  SessionState,
  SubagentRow,
  ThreadDetail,
  ThreadEntry,
  WbCardTarget,
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

/* ── "N files changed" (#416) — same rule as web's turnChangedFiles ─────── */

/** Tools whose args name the workspace files they write. */
const FILE_WRITE_TOOLS = new Set(["write_file", "patch"]);

/** V4A multi-file patch headers — `*** Add|Update|Delete|Move File: <path>`
    inside a `patch` call's `patch` arg (no `path` arg in that mode). */
const V4A_FILE = /\*\*\* (?:Add|Update|Delete|Move) File: (.+)/g;

const normPath = (p: string) => p.trim().replace(/^\.\//, "");

/* What a completed file-write call touched, read from its own args — the
   count's ground truth when no diff was emitted (ACP) or the diff's path is
   a placeholder. A denied/failed write changed nothing. */
function inputPaths(s: TurnStep): string[] {
  if (!FILE_WRITE_TOOLS.has(s.tool)) return [];
  if (s.status !== "completed") return [];
  const out: string[] = [];
  const p = s.input?.path;
  if (typeof p === "string" && p) out.push(normPath(p));
  const v = s.input?.patch;
  if (typeof v === "string")
    for (const m of v.matchAll(V4A_FILE)) out.push(normPath(m[1]));
  return out;
}

/* The files one step changed — the write call's own args first, else its
   diff's path. */
function stepChangedPaths(s: TurnStep): string[] {
  const paths = inputPaths(s);
  return paths.length ? paths : s.diff ? [s.diff.path] : [];
}

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
        grantOptions:
          open.request.kind === "approval" ? open.request.options : undefined,
        /* #553: a question ask carries its answer buttons + free-text
           flag — the shared QuestionCard renders both (AC-1). */
        options:
          open.request.kind === "question" ? open.request.options : undefined,
        freeText:
          open.request.kind === "question" ? open.request.freeText : undefined,
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
            resolved.outcome === "session" ||
            resolved.outcome === "always" ||
            resolved.outcome === "approve" ||
            resolved.outcome === "answer",
          /* #553: an answered question's receipt names the answer — the
             option's label when the wire kept an id, the typed text
             otherwise; a skipped question reads its question. */
          what:
            resolved.request.kind === "question" &&
            resolved.outcome === "answer"
              ? (resolved.request.options?.find((o) => o.id === resolved.answer)
                  ?.label ??
                resolved.answer ??
                askReason(resolved))
              : askReason(resolved),
          question: resolved.request.kind === "question" ? true : undefined,
          /* #601: the receipt names the granted outcome — "This session"
              reads differently from "always". */
          outcome: resolved.outcome,
        },
      }
    : {};
}

/** TurnModel -> the AgentEntry the thread renders (live or finished). */
function toAgentEntry(
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
    turn.phase !== "failed" &&
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
  /* #419: a turn ended on `turn.completed.error` reads failed — the entry
     carries the engine's error text like web's failure chip. */
  const failed = turn.phase === "failed" ? turn.error : undefined;
  /* #416: same count as web's turnChangedFiles — a completed write call's
     own args name the file it touched, so creates/ACP turns count without
     an emitted diff; helpers in the same checkout count too. */
  const files = new Set(
    [
      ...turn.steps,
      ...turn.subagents.flatMap((a) => (a.employee ? [] : a.steps)),
    ].flatMap(stepChangedPaths),
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
    ...(failed !== undefined ? { failed } : {}),
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
 * the end. `rewound` (#134): refs/texts hide rewound-tail turns. Tombstone
 * rows (#425: `dropped`/`removed`) never enter — the read layer already omits
 * them, and the live merge re-drops them before they can render or anchor.
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
  /* #425: `removed`/`dropped` tombstones ride the live merge (message.changed
     replaces the row in place; channel.snapshot carries them, #377) even
     though the read layer omits them on fetch — so the merge drops them
     again here, the same cut the Mac's waiting tray makes (#315): the phone
     has no tray, so a parked or removed send renders nowhere at all. The
     filter comes before every positional pass — a tombstoned row can never
     anchor a turn (it was never delivered) or be claimed as an answer. */
  const visible = messages.filter((m) => !m.dropped && !m.removed);
  /* #258: `deliveredSeq` is a durability watermark — the harness advances
     it once the turn's outcome is secured (turn end), not when the engine
     starts the turn. "Past the watermark" therefore means queued OR
     in-flight; the precise "its turn started" signal is `turn.started`'s
     `ref` naming this message — check it before stamping the caption so
     a running turn's prompt never reads "Queued · runs next". */
  const startedRefs = new Set(
    model?.turns.flatMap((t) => (t.ref ? [t.ref] : [])) ?? [],
  );
  const entries: ThreadEntry[] = visible.map((m) =>
    m.authorKind === "user"
      ? {
          kind: "user",
          id: m.id,
          time: clock(m.createdAt),
          text: m.text,
          /* #425: `claimed` rows keep the bubble but lose the caption — the
             harness committed the send to the engine pipeline (#377), so it
             is mid-dispatch, never queued. Same rule as the Mac, where a
             claimed row leaves the waiting tray but stays a sent bubble. */
          ...(opts.deliveredSeq !== undefined &&
          m.seq > opts.deliveredSeq &&
          !m.claimed &&
          !startedRefs.has(m.id)
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
     (done/stopped) claims on exact text; the still-live turn claims on a
     text prefix (#691 — the posted row wins its race against the settling
     feed events), and `used` then keeps the tail pass from rendering its
     card a second time. */
  const promptIdx = new Map<TurnModel, number>();
  for (const t of model.turns) {
    if (!t.ref) continue;
    const i = visible.findIndex((x) => x.id === t.ref);
    if (i >= 0) promptIdx.set(t, i);
  }
  const used = new Set<TurnModel>();
  /* Newest row a leg claimed (#308) — the pass-2 cursor below. */
  let legClaimed = -1;
  /* dur = prompt -> reply latency, the only honest wall-clock available. */
  const claimedEntry = (t: TurnModel, m: AppMessage) => {
    const prompt = t.ref ? visible.find((x) => x.id === t.ref) : undefined;
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
  for (const [mi, m] of visible.entries()) {
    if (m.authorKind !== "employee") continue;
    const turn = model.turns.find((x) => {
      if (
        used.has(x) ||
        x.agentInitiated ||
        !m.text.trim() ||
        (promptIdx.get(x) ?? -1) >= mi
      )
        return false;
      const txt = x.text.trim();
      if (
        x.phase === "done" ||
        x.phase === "stopped" ||
        /* #419: a failed turn's partial answer posts too — claim it. */
        x.phase === "failed"
      )
        return txt !== "" && txt === m.text.trim();
      /* #691 (web parity, #659): the harness posts the answer row — and
         flips the conversation back to `idle` — the instant its
         turn.completed lands, while the feed's last turn.delta frames
         are still in flight on the other socket. The turn is still live
         in the model and holds only a prefix of the posted text (or
         nothing yet); let it claim the row or the bare row and its card
         render the same answer twice. `model.live`, not `liveTurn`:
         conv.state is already `idle` in this window, so the #327 clamp
         would make the claim unreachable. */
      return x === model.live && m.text.trim().startsWith(txt);
    });
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
      (t.phase !== "done" && t.phase !== "stopped" && t.phase !== "failed") ||
      !t.text.trim()
    )
      continue;
    let mi = -1;
    for (let i = legClaimed + 1; i < visible.length; i++) {
      const m = visible[i];
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
    const m = visible[mi];
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
    /* #419: a failed turn with nothing to show still renders — its
       failure row is the only surface the error has (same as stopped). */
    if (
      empty &&
      t.phase !== "stopped" &&
      t.phase !== "failed" &&
      t !== liveTurn
    )
      return false;
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
     byRef is stale past the leftover splices, so look the row up fresh.
     A live turn that already claimed its posted row (#691) is `used` —
     rendering it here too would double its card under one `turn-<id>`
     key (the failure this issue reports). */
  if (liveTurn && !used.has(liveTurn)) {
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
  /** `workbench.opened` events for this thread (#340 AC-2b) — the phone's
     tappable "look at this" cards, appended after the conversation. */
  wbCards?: readonly { at: number; target: WbCardTarget }[];
  /** #514: the feed's `historyTrimmed` (#431) — the engine's capped log
     dropped this session's head, so the transcript says so instead of
     letting the missing prefix read as a render gap (web: transcriptNote). */
  historyTrimmed?: boolean;
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
  /* #587 AC-2: helpers list ONLY under Subagents — no merge into the
     Background job rows. */
  const jobs = jobsById.size
    ? [...jobsById.values()].map((j) => toJobRow(j, opts.now))
    : undefined;
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
    /* #592: the header chip reads amber "Mac went to sleep" for sleep
       interrupts, red "Failed" for model/generic errors. */
    ...(conv.turnFailure ? { failure: conv.turnFailure } : {}),
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
    /* ctxUsage is the newest CUMULATIVE usage — summing cumulative
       per-turn payloads across turns would count the session N× (#415). */
    usage:
      ctxUsage && (ctxUsage.input || ctxUsage.output)
        ? usageLabel(ctxUsage)
        : undefined,
    ...(ctxUsage
      ? {
          context: {
            input: ctxUsage.input,
            output: ctxUsage.output,
            reasoning: ctxUsage.reasoning ?? 0,
            cache: ctxUsage.cache ?? 0,
            /* Live occupancy is the meter's numerator when the engine
               reports it (#415). */
            ...(ctxUsage.context !== undefined
              ? { context: ctxUsage.context }
              : {}),
            max: ctxWindow.tokens,
            estimated: ctxWindow.estimated,
          },
        }
      : {}),
    jobs,
    ...(opts.prs?.length ? { prs: [...opts.prs] } : {}),
    ...(opts.historyTrimmed
      ? {
          transcriptNote:
            "Earlier history was trimmed — this session's event log is capped.",
        }
      : {}),
    entries: [
      ...entries,
      /* #340 AC-2b: a `workbench_open` is the agent's "look at this" —
         the card tail like a system note, newest last. */
      ...(opts.wbCards ?? []).map((c, i) => ({
        kind: "workbench" as const,
        id: `wb-${c.at}-${i}`,
        time: clock(c.at),
        target: c.target,
      })),
    ],
  };
}

/** The session's recorded edits as {path, patch} rows — the phone's
    Changes view behind a `workbench_open` card (the relay keeps no fs;
    the turn steps' unified diffs are what it can honestly show). */
export function collectDiffs(
  entries: readonly ThreadEntry[],
): { path: string; patch: string }[] {
  const byPath = new Map<string, string[]>();
  for (const e of entries) {
    if (e.kind !== "agent") continue;
    for (const s of e.steps ?? []) {
      if (!s.patch) continue;
      const path = s.arg ?? patchPath(s.patch) ?? "file";
      byPath.set(path, [...(byPath.get(path) ?? []), s.patch]);
    }
  }
  return [...byPath.entries()].map(([path, patches]) => ({
    path,
    patch: patches.join("\n"),
  }));
}
const patchPath = (patch: string): string | undefined =>
  /^\+\+\+ b\/(.+)$/m.exec(patch)?.[1];

/** #591 AC-3 spirit: while the Mac is unreachable a "working" thread is
    stale, not live — the header reads "Last seen working" and Stop is
    disabled (it can't be delivered; the note says it works once the Mac
    is back). Terminal states are facts, not lies — they stay as-is. */
export function threadSurface(
  state: SessionState,
  unreachable: boolean,
  macName?: string,
): {
  running: boolean;
  stale: boolean;
  stopHint?: string;
  asksStale: boolean;
  answerHint?: string;
} {
  const stale = unreachable && state === "working";
  return {
    running: state === "working" && !stale,
    stale,
    ...(stale ? { stopHint: "Stop works once the Mac is back" as const } : {}),
    /* #652: an open ask can't be answered while the Mac is unreachable —
       ANY state, not only a thread claiming a live turn (`stale`). The
       card's pills render disabled and the hint says they wake when the
       Mac is back; nothing is sent or queued meanwhile. */
    asksStale: unreachable,
    ...(unreachable
      ? { answerHint: `Answer once ${macName ?? "the Mac"} is back` }
      : {}),
  };
}

/** #596 AC-2: a Thread opened on a conversationId the wire doesn't know
   yet is still loading — only once the first directory sync lands is it
   really gone. Before this, both states rendered the same empty body and
   an unknown id stayed blank forever. */
export function threadBodyState(
  known: boolean,
  directoryReady: boolean,
): "loading" | "gone" | undefined {
  if (known) return undefined;
  return directoryReady ? "gone" : "loading";
}
