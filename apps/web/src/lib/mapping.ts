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
  SummaryMessage,
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
import { attachmentUrls, toAttachedFiles } from "./attachments";

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

/* #427: `toLocaleTimeString` with options built a fresh Intl.DateTimeFormat
   per message per render — the top of the long-thread profile. `[]` means
   "default locale", so one formatter serves every call. */
const CLOCK_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
export const clock = (ts: number) => CLOCK_FMT.format(new Date(ts));

const PHASE_MAP: Record<TurnModel["phase"], Phase> = {
  submitted: "submitted",
  reasoning: "thinking",
  tools: "tools",
  text: "typing",
  waiting: "waiting",
  done: "done",
  stopped: "stopped",
  failed: "failed",
};

/* #180: a turn's plan/task-list snapshot -> the ui Plan the PlanCard renders.
   A tasks list under 2 items is noise (issue default) and is never mapped. */
function toUiPlan(p: TurnPlan): UiPlan | undefined {
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
    status: s.status,
    ...(dispatched ? { dispatched: true } : {}),
    diff: s.diff as Step["diff"],
    commit: s.commit as Step["commit"],
  };
}

/* ── #179: subagent + background-job model -> ui types ─────────────────── */

/** A helper row inside the turn's Subagents block. */
function toSubagent(
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
    started: j.startedAt ? clock(j.startedAt) : "",
    uptime: j.startedAt
      ? formatUptime(((j.endedAt ?? now) - j.startedAt) / 1000)
      : "0s",
    ...(j.url ? { url: j.url } : {}),
    ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}),
    log: j.tail,
    ...(j.by ? { by: j.by } : {}),
  };
}

/** A live engine turn rendered as the employee's in-progress reply. */
export function liveTurnReply(
  turn: TurnModel,
  employeeId: string,
  asks: Ask[] = [],
  resolveEmployee: (employeeRef: string) => string = (r) => r,
  liveNow = true,
): Reply {
  // Approvals render from relay asks (the responder identity is the ask id);
  // turn.requests only mark the phase "waiting". An open ask wins; else the
  // turn's most recent resolved approval keeps its card (outcome label shows
  // via `resolved[ask.id]`).
  const approvals = asks.filter(
    (a) => a.turnId === turn.turnId && a.request.kind === "approval",
  );
  /* #553: question asks ride the same relay-ask path — an open ask wins,
     else the turn's most recent resolved question keeps its card so the
     receipt (resolved[ask.id]) has somewhere to land. */
  const questions = asks.filter(
    (a) => a.turnId === turn.turnId && a.request.kind === "question",
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
          /* #106 AC-4: the card's buttons follow the options the engine
             offered, not a fixed set. */
          options: shown.request.options,
        }
      : undefined;
  const qShown =
    questions.find((a) => a.state === "open") ?? questions.at(-1);
  const question =
    qShown && qShown.request.kind === "question"
      ? {
          id: qShown.id,
          question: qShown.request.question,
          options: qShown.request.options,
          freeText: qShown.request.freeText,
        }
      : undefined;
  return {
    id: `live-${turn.turnId}`,
    turnId: turn.turnId,
    ...(turn.postAttach !== undefined ? { postAttach: turn.postAttach } : {}),
    from: employeeId,
    time: "",
    text: turn.text,
    reasoning: turn.reasoning || undefined,
    steps: turn.steps.map((s) => toStep(s, turn)),
    steers: turn.steers,
    streaming: turn.phase === "text" ? turn.text : undefined,
    approval,
    question,
    model: turn.model,
    effort: turn.effort,
    fast: turn.fast,
    phase: PHASE_MAP[turn.phase],
    /* #327: `liveNow` is mergeTurns' conversation-state clamp — a settled
       phase alone can't mark a turn dead when the feed degraded before
       the reducer's settle could see it. */
    live:
      liveNow &&
      turn.phase !== "done" &&
      turn.phase !== "stopped" &&
      turn.phase !== "failed",
    ...(turn.error ? { error: turn.error } : {}),
    ...(turn.agentInitiated ? { agentInitiated: true } : {}),
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

/* #553: a resolved question ask's receipt — "Answered "<label>" by <name>"
   when the wire kept an option id (the option's human wording) or a typed
   answer (the text itself); "Cancelled by <name>" on Skip. */
export function questionReceipt(ask: Ask, name: string): string {
  if (ask.outcome === "answer") {
    const label =
      (ask.request.kind === "question"
        ? ask.request.options?.find((o) => o.id === ask.answer)?.label
        : undefined) ??
      ask.answer ??
      "";
    return `Answered “${label}” by ${name}`;
  }
  return `Cancelled by ${name}`;
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

/** The live reply plus any superseded plan versions folded ahead of it.
    Exported for conv-fold's per-turn cache (#430) — callers should prefer
    `mergeTurns`' `liveFor` hook over calling this directly. */
export function liveReplies(
  turn: TurnModel,
  employeeId: string,
  asks: Ask[],
  resolveEmployee: (employeeRef: string) => string = (r) => r,
  liveNow = true,
): Reply[] {
  return [
    ...supersededPlanReplies(turn, employeeId),
    liveTurnReply(turn, employeeId, asks, resolveEmployee, liveNow),
  ];
}

/* AC-6 (D-#19): plan surfaces render only when the engine declares `plan` —
   drop plan cards and the empty synthetic rows that carried them.
   `cache` (#430): the strip clones a plan-carrying row — without it every
   re-fold breaks the row's identity for the memoized renderer. */
export function stripPlans(
  replies: Reply[],
  cache?: WeakMap<Reply, Reply>,
): Reply[] {
  return replies
    .map((r) => {
      if (!r.plan) return r;
      const hit = cache?.get(r);
      if (hit) return hit;
      const stripped = { ...r, plan: undefined };
      cache?.set(r, stripped);
      return stripped;
    })
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

/** #571: summary rows carry the preview subset of a message — these
    mappers read only fields both shapes share. */
type ReplySource = AppMessage | SummaryMessage;

/* One relay row -> one Reply. conv-fold caches these per message row so
   rows untouched by a delta keep their identity for the memoized
   renderer (#430). #585: system rows carry `system` and keep their text
   bare — the renderer draws the centred note and the prefix is gone from
   what the reader sees. */
const messageReply = (m: ReplySource): Reply => ({
  id: m.id,
  from: m.authorKind === "system" ? "" : m.authorId,
  time: clock(m.createdAt),
  text: m.text,
  ...(m.authorKind === "system" ? { system: true } : {}),
  model: m.model,
  effort: m.effort,
  fast: m.fast,
  phase: m.authorKind === "employee" ? "done" : undefined,
  attachments: toAttachedFiles(m.attachments),
});

/** Relay channel messages for one conversation -> ui Reply[].
    `cache` (#430): pass a WeakMap keyed on the message row to keep Reply
    identity stable across re-folds. */
export function conversationReplies(
  messages: ReplySource[],
  conversationId: string,
  cache?: WeakMap<ReplySource, Reply>,
): Reply[] {
  return (
    messages
      .filter((m) => m.conversationId === conversationId)
      // Older DBs may hold pre-#71 `⚙ …` tool-event system rows; the tool
      // cards inside the turn are the single rendering, so drop them (AC-1).
      .filter((m) => m.authorKind !== "system" || !m.text.startsWith("⚙"))
      .map((m) => {
        if (!cache) return messageReply(m);
        const hit = cache.get(m);
        if (hit) return hit;
        const r = messageReply(m);
        /* #572/#112: a ref whose blob hasn't resolved yet bakes
           `url: undefined` — recheck on the next fold instead of freezing
           the thumbnail-less reply for the row's lifetime. */
        if (!m.attachments?.some((a) => !attachmentUrls.get()[a.id]))
          cache.set(m, r);
        return r;
      })
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
 *
 * #308: `ref` is a position, not just an orphan filter — a turn anchored to
 * a visible prompt renders right under it regardless of when its answer's
 * relay row arrived (a reply can post after a newer user message and still
 * belongs under its own question). Engine-initiated legs are their own
 * agent entry anchored right after the turn that ran before them (never
 * tail-appended below user messages that landed while they worked — AC-3);
 * a finished leg whose text the harness already posted as a plain employee
 * row CLAIMS that row like a prompt turn would, but only past every
 * already-claimed row — it can never steal an earlier answer's slot.
 *
 * `rootMessageId` is the thread's root question — callers strip it out of
 * `replies` (it renders as the thread header instead), so a turn it
 * prompted anchors at the TOP of the reply list, directly under the header.
 *
 * `model` = "pending" (#467) marks an engine-backed conversation whose feed
 * has not stamped its attach watermark yet (first `events.since` replay still
 * in flight). Without the replay the anchor pass can't place anything — raw
 * relay rows would paint every employee post after the newest user row for a
 * frame, the inverse of the #308 invariant once the model binds. Employee
 * posts are held until attach instead; user rows (and the transcript note)
 * still render. A non-engine conversation passes `undefined` — there is no
 * model to wait for, so its relay rows pass through unchanged.
 *
 * `liveFor` (#430) builds one turn's reply block — `(turn, liveNow,
 * claimId)` where `claimId` is the relay row id the block must end on
 * (the claim passes). The default below is the plain `liveReplies` +
 * id-patch; conv-fold swaps in a per-turn memo so an incremental delta
 * keeps Reply identity for every turn the tail didn't touch.
 */
export function mergeTurns(
  replies: Reply[],
  model: SessionModel | "pending" | undefined,
  employeeId: string,
  asks: Ask[] = [],
  rewound?: { refs?: ReadonlySet<string>; texts?: ReadonlySet<string> },
  resolveEmployee: (employeeRef: string) => string = (r) => r,
  rootMessageId?: string,
  conversationState?: Conversation["state"],
  liveFor?: (turn: TurnModel, liveNow: boolean, claimId?: string) => Reply[],
): Reply[] {
  if (!model) return replies;
  if (model === "pending") return replies.filter((r) => r.from !== employeeId);
  const blockFor =
    liveFor ??
    ((t: TurnModel, liveNow: boolean, claimId?: string) => {
      const rs = liveReplies(t, employeeId, asks, resolveEmployee, liveNow);
      if (claimId !== undefined)
        rs[rs.length - 1] = { ...rs[rs.length - 1], id: claimId };
      return rs;
    });
  /* #327: the relay conversation's own word on whether a turn can run —
     a degraded feed that skipped its session.state events can't keep a
     card live behind the relay's idle/closed (mobile's liveTurn parity). */
  const liveTurn =
    conversationState === undefined || conversationState === "active"
      ? model.live
      : undefined;
  const used = new Set<TurnModel>();
  /* Each reply run is one block — superseded-plan rows travel with their
     card when a ref'd turn re-anchors. */
  const blocks: Reply[][] = [];
  const owned = new Set<Reply[]>();
  const turnBlock = new Map<TurnModel, Reply[]>();
  /* Position-bound like mobile (#181 AC-4): a ref'd turn claims only a
     message that renders after its prompt — a rebound session's turn
     otherwise steals an older identical reply and vacates its slot. */
  const refPos = new Map<TurnModel, number>();
  for (const t of model.turns) {
    if (!t.ref) continue;
    const i = replies.findIndex((x) => x.id === t.ref);
    if (i >= 0) refPos.set(t, i);
  }
  for (const [ri, r] of replies.entries()) {
    const t = model.turns.find(
      (x) =>
        !used.has(x) &&
        !x.agentInitiated &&
        r.from === employeeId &&
        (refPos.get(x) ?? -1) < ri &&
        r.text.trim() !== "" &&
        (x.text.trim() === r.text.trim() ||
          /* #659: the harness posts the answer row — and flips the
             conversation back to `idle` — the instant its turn.completed
             lands, while the model's last turn.delta frames can still be
             in flight on the feed socket. The row is this turn's answer
             even though the card has only streamed a prefix of it (or
             nothing yet), so the exact match misses and row + card both
             render. The model's live turn claims it early; the in-flight
             deltas can only converge to the posted text. `model.live`,
             not the #327 `liveTurn`: conv.state is already `idle` in this
             window — gating on it would make the claim unreachable. */
          (x === model.live && r.text.trim().startsWith(x.text.trim()))),
    );
    if (!t) {
      blocks.push([r]);
      continue;
    }
    used.add(t);
    // Keep the relay message id — it's the search-hit scroll anchor (#138).
    const live = blockFor(t, t === liveTurn, r.id);
    blocks.push(live);
    owned.add(live);
    turnBlock.set(t, live);
  }
  /* #308: a finished agent leg's text also posts to the relay as a plain
     employee row (harness finishTurn, no ref correlation). Claim that row
     into the leg's card — without this the card renders AND the bare row
     stays, one answer twice. Claimed rows already sit inside a turn card
     (their block is longer than the row), so the singleton check below
     alone keeps a leg from stealing a claimed answer; the legClaimed
     cursor pairs same-text legs with their posts in order. */
  let legClaimed = -1;
  for (const t of model.turns) {
    if (
      !t.agentInitiated ||
      used.has(t) ||
      !t.text.trim() ||
      (t.phase !== "done" &&
        t.phase !== "stopped" &&
        /* #419: a failed leg still claims the row its partial text posted
           (finishTurn ships whatever streamed before the error). */
        t.phase !== "failed")
    )
      continue;
    let ri = -1;
    for (let i = legClaimed + 1; i < replies.length; i++) {
      const r = replies[i];
      if (
        r.from === employeeId &&
        r.text.trim() === t.text.trim() &&
        blocks[i].length === 1 &&
        blocks[i][0] === r
      ) {
        ri = i;
        break;
      }
    }
    if (ri < 0) continue;
    used.add(t);
    legClaimed = ri;
    const live = blockFor(t, t === liveTurn, replies[ri].id);
    blocks[ri] = live;
    owned.add(live);
    turnBlock.set(t, live);
  }
  /* Anchor pass (#308): a `ref`'d turn sits right after the message that
     prompted it — claimed cards move there from wherever the text matched;
     unposted turns insert. `refOffset` stacks several turns under one
     prompt in turn order. */
  const refIndex = (ref: string) =>
    blocks.findIndex((b) => b.some((r) => r.id === ref));
  /* Landing under a prompt never leapfrogs turn cards already holding that
     slot — a claimed card whose own `ref` renders nowhere (the thread's
     root question is filtered out of `replies`) keeps the slot its relay
     row earned, so a newer anchored card queues after it instead. */
  const beyond = (i: number) => {
    let at = i;
    while (at < blocks.length && owned.has(blocks[at])) at++;
    return at;
  };
  const refOffset = new Map<string, number>();
  const anchorAt = (t: TurnModel) => {
    if (!t.ref) return -1;
    const at = refIndex(t.ref);
    if (at < 0)
      /* The root question is filtered out of `replies` (it is the thread
         header) — a turn it prompted anchors at the top, directly under
         the header. A newer user message never renders above the root
         question's own answer (AC-1). */
      return t.ref === rootMessageId ? (refOffset.get(t.ref) ?? 0) : -1;
    return at + 1 + (refOffset.get(t.ref) ?? 0);
  };
  const bump = (t: TurnModel) => {
    if (t.ref) refOffset.set(t.ref, (refOffset.get(t.ref) ?? 0) + 1);
  };
  /* #370: the newest turn that can still claim a relay row — watched
     live (`liveAttached`), finished, and the first turn for its `ref`
     (a later re-answer's post dedupes into the first's row and can
     never claim). Only it bridges the settle→claim window; anything
     older whose row still hasn't landed is #288's orphan again. */
  let newestClaimable: TurnModel | undefined;
  for (const x of model.turns)
    if (
      x.liveAttached &&
      !x.agentInitiated &&
      (x.phase === "done" || x.phase === "stopped" || x.phase === "failed") &&
      model.turns.find((y) => y.ref === x.ref) === x
    )
      newestClaimable = x;
  /* #308 AC-3: block index right after the previous turn's card — an
     agent-initiated leg sits there (above user messages that landed while
     it worked), claimed or live. */
  let prevEnd = 0;
  const legSlot = (from: number) =>
    prevEnd - (from >= 0 && from < prevEnd ? 1 : 0);
  for (const t of model.turns) {
    const block = turnBlock.get(t);
    const at = anchorAt(t);
    if (block) {
      /* A claimed card re-anchors to its prompting message; if that message
         renders nowhere the claim's own correlation keeps the card where
         its relay row landed (#288's drop only covers unposted turns). A
         claimed LEG re-anchors to the previous turn's end instead (AC-3). */
      if (at < 0) {
        if (t.agentInitiated) {
          const from = blocks.indexOf(block);
          const dest = legSlot(from);
          if (dest !== from) {
            blocks.splice(from, 1);
            blocks.splice(dest, 0, block);
          }
          prevEnd = blocks.indexOf(block) + 1;
        } else prevEnd = blocks.indexOf(block) + 1;
        continue;
      }
      const from = blocks.indexOf(block);
      /* Already inside the anchored run under its prompt — the run holds
         same-ref turns in order, so leave it. */
      if (from >= at && from < beyond(at)) {
        bump(t);
        prevEnd = from + 1;
        continue;
      }
      blocks.splice(from, 1);
      const dest = beyond(at - (from < at ? 1 : 0));
      blocks.splice(dest, 0, block);
      bump(t);
      prevEnd = dest + 1;
      continue;
    }
    if (t.ref ? rewound?.refs?.has(t.ref) : rewound?.texts?.has(t.text.trim()))
      continue;
    /* #419: a failed turn with no output still renders — its failure chip
       is the only surface the error has (same reason stopped stays).
       #585 AC-2: a turn whose ask was answered (denied, cancelled) keeps
       its card too — `requests` non-empty means the turn opened a request
       the user resolved, and the card is the only surface of that outcome. */
    if (
      !t.text.trim() &&
      t.phase !== "stopped" &&
      t.phase !== "failed" &&
      t.requests.length === 0 &&
      t !== liveTurn
    )
      continue;
    const rs = blockFor(t, t === liveTurn);
    /* #288: a finished turn anchored to a message that renders nowhere is
       an orphan — e.g. a rebound engine session re-answering a question
       that no reply row carries (the root renders as the thread header,
       not a reply row, so it counts as invisible here too). Stopped
       turns keep the tail/live anchor: their marker is the only surface
       of a stop on an invisible prompt. Ref-less turns keep the tail
       fallback too: engines that never echo `ref` can't be positioned
       any other way. #370: `newestClaimable` — the turn the feed just
       watched finish and the only one whose relay answer can still be
       in flight — holds its slot through the settle→claim window
       instead of unmounting for a frame. The window ends when a newer
       claimable settle exists (a rewound or deduped answer leaves a
       ghost, not a card in flight) or when the answer's own row is
       known to be rewound — then it is the same orphan as #288's
       replayed re-answer and drops. */
    if (
      t.ref &&
      refIndex(t.ref) < 0 &&
      t.phase !== "stopped" &&
      /* #419: a failed turn's error must not drop as an orphan either. */
      t.phase !== "failed" &&
      t !== liveTurn &&
      !(t === newestClaimable && !rewound?.texts?.has(t.text.trim()))
    )
      continue;
    if (at < 0) {
      owned.add(rs);
      if (t.agentInitiated) {
        /* AC-3: the leg sits right after the previous turn's card — a
           user message that landed while it worked never renders above
           running work. */
        const dest = Math.min(prevEnd, blocks.length);
        blocks.splice(dest, 0, rs);
        prevEnd = dest + 1;
      } else {
        blocks.push(rs);
        prevEnd = blocks.length;
      }
      continue;
    }
    owned.add(rs);
    const dest = beyond(at);
    blocks.splice(dest, 0, rs);
    bump(t);
    prevEnd = dest + 1;
  }
  /* #585 AC-1: a system note that only repeats what its neighbour already
     says drops out — "Stopped." beside a stopped turn, "Error:" beside a
     failed one, the silent-end note beside a turn whose card still shows
     (the denied ask is the real state). The note lands right before or
     right after the turn it describes (relay seq order); matching is
     positional because dedupeKey never crosses the wire. Notes that say
     something no neighbour shows (auto-approved, worktree/model errors)
     always stay. */
  const isNote = (b: Reply[]) => b.length === 1 && !!b[0].system;
  const hasCard = (r: Reply) =>
    !!r.approval || !!r.question || !!r.plan || !!r.steps?.length;
  const duplicates = (note: Reply, turn?: Reply) => {
    if (!turn || turn.system || !turn.turnId) return false;
    const t = note.text;
    if (t === "Stopped.") return turn.phase === "stopped";
    if (t.startsWith("Error: ") || t.startsWith("Turn interrupted"))
      return turn.phase === "failed";
    if (t === "(the engine ended the turn silently)")
      return !turn.text.trim() && hasCard(turn);
    return false;
  };
  const kept = blocks.filter((b, bi) => {
    if (!isNote(b)) return true;
    let prev: Reply | undefined;
    for (let i = bi - 1; i >= 0 && !prev; i--) {
      const x = blocks[i];
      if (!isNote(x)) prev = x[x.length - 1];
    }
    const next = blocks
      .slice(bi + 1)
      .find((x) => !isNote(x))
      ?.at(-1);
    return !duplicates(b[0], prev) && !duplicates(b[0], next);
  });
  return kept.flat();
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
 * #586: the short tag thread chrome shows for a session — Hermes stamps
 * engine refs date-first (`20261006_221236_cfe2c4`), so two same-day
 * sessions share a `slice(0,8)` prefix; the unique part is the TAIL.
 * The last six alphanumeric characters fit every ref shape (uuid tails,
 * `s<N>`, conv ids) — long enough that collisions need ~17M threads.
 */
export function sessionLabel(ref: string): string {
  const m = /[a-zA-Z0-9]{1,6}$/.exec(ref.replace(/[^a-zA-Z0-9]+$/, ""));
  return m ? m[0] : ref;
}

/**
 * The DM home feed: one Msg row per conversation (root user message). Pass
 * `mergeTurns` output as `replies` so engine turns show as rich cards.
 */
export function toFeed(
  root: ReplySource,
  conv: Conversation,
  replies: Reply[],
  /** Folder the session works in (#113) — feeds the row + header badges. */
  ws?: Workspace,
  /** The session's background processes (#583 AC-3) — the row says when
      one is still running. */
  jobs?: BackgroundJob[],
): Msg {
  return {
    kind: "msg",
    id: root.id,
    from: root.authorId,
    time: clock(root.createdAt),
    text: root.text,
    attachments: toAttachedFiles(root.attachments),
    thread: {
      session: sessionLabel(conv.engineRef ?? conv.id),
      title: conv.title || undefined,
      archived: conv.archived,
      /* #346 AC-4: the stored open/closed bit — `running` itself is
         derived by sessionLife from the replies, never stored. */
      ...(conv.life ? { life: conv.life } : {}),
      replies,
      /* #419: the session row's failure card — the harness stamps
         `turnFailure` when a turn dies on an error or a sleep/restart
         interrupt; Retry re-sends the user's last message (dm.tsx). */
      ...(conv.turnFailure
        ? { alert: { ...conv.turnFailure, retry: true } }
        : {}),
      /* #583: a stopped turn's word — relay-persisted like `turnFailure`
         so a released session's summary-only row still says "stopped". */
      ...(conv.turnStopped ? { stopped: true } : {}),
      /* #583 AC-3: the relay-stamped running-job count — the row's badge
         renders before the session feed lands. */
      ...(conv.bgJobs ? { bgJobs: conv.bgJobs } : {}),
      ...(ws ? { ws } : {}),
      ...(jobs?.length ? { jobs } : {}),
    },
  };
}
