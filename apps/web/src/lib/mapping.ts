import type { SessionModel, TurnModel } from "@lilos/client-runtime";
import type {
  AppMessage,
  Ask,
  Conversation,
  Employee,
} from "@lilos/contracts/app";
import type {
  Msg,
  Phase,
  Reply,
  Step,
  Employee as UiEmployee,
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

function toStep(s: TurnModel["steps"][number]): Step {
  return {
    tool: s.tool,
    input: s.input,
    output: s.output ?? "",
    running: s.status === "running",
    diff: s.diff as Step["diff"],
    commit: s.commit as Step["commit"],
  };
}

/** A live engine turn rendered as the employee's in-progress reply. */
export function liveTurnReply(
  turn: TurnModel,
  employeeId: string,
  asks: Ask[] = [],
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
    steps: turn.steps.map(toStep),
    steers: turn.steers,
    streaming: turn.phase === "text" ? turn.text : undefined,
    approval,
    model: turn.model,
    effort: turn.effort,
    fast: turn.fast,
    phase: PHASE_MAP[turn.phase],
    live: turn.phase !== "done" && turn.phase !== "stopped",
    waitingOn: turn.phase === "waiting" ? open?.request.kind : undefined,
  };
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
 */
export function mergeTurns(
  replies: Reply[],
  model: SessionModel | undefined,
  employeeId: string,
  asks: Ask[] = [],
): Reply[] {
  if (!model) return replies;
  const used = new Set<TurnModel>();
  const out = replies.map((r) => {
    const t = model.turns.find(
      (x) =>
        !used.has(x) &&
        r.from === employeeId &&
        x.text.trim() &&
        x.text.trim() === r.text.trim(),
    );
    if (!t) return r;
    used.add(t);
    // Keep the relay message id — it's the search-hit scroll anchor (#138).
    return { ...liveTurnReply(t, employeeId, asks), id: r.id };
  });
  /* A finished turn with no relay message (a stop before any text) sits
     right after the user message that prompted it (`turn.started.ref`), not
     at the end — appended, it jumped below every later message and answer.
     The live turn is always the newest, so it still goes last. */
  for (const t of model.turns) {
    if (used.has(t) || t === model.live) continue;
    if (!t.text.trim() && t.phase !== "stopped") continue;
    const at = t.ref ? out.findIndex((r) => r.id === t.ref) : -1;
    if (at < 0) out.push(liveTurnReply(t, employeeId, asks));
    else out.splice(at + 1, 0, liveTurnReply(t, employeeId, asks));
  }
  if (model.live && !used.has(model.live))
    out.push(liveTurnReply(model.live, employeeId, asks));
  return out;
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
