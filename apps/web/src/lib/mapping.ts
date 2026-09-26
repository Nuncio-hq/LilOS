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
} from "@lilos/ui/types";

/** relay domain -> ui/domain type mapping (the only place it lives). */

export function toUiEmployee(e: Employee): UiEmployee {
  return {
    id: e.id,
    name: e.name,
    role: e.role,
    status:
      e.status === "busy"
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
  waiting: "tools",
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
    phase: PHASE_MAP[turn.phase],
    live: turn.phase !== "done" && turn.phase !== "stopped",
  };
}

/** Relay channel messages for one conversation -> ui Reply[]. */
export function conversationReplies(
  messages: AppMessage[],
  conversationId: string,
): Reply[] {
  return messages
    .filter((m) => m.conversationId === conversationId)
    .map((m) => ({
      id: m.id,
      from: m.authorKind === "system" ? "" : m.authorId,
      time: clock(m.createdAt),
      text: m.authorKind === "system" ? `⚠ ${m.text}` : m.text,
      phase: m.authorKind === "employee" ? "done" : undefined,
    }));
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
    return liveTurnReply(t, employeeId, asks);
  });
  for (const t of model.turns) {
    if (used.has(t)) continue;
    if (t === model.live || t.text.trim() || t.phase === "stopped")
      out.push(liveTurnReply(t, employeeId, asks));
  }
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
): Msg {
  return {
    kind: "msg",
    id: root.id,
    from: root.authorId,
    time: clock(root.createdAt),
    text: root.text,
    thread: {
      session: conv.engineRef?.slice(0, 8) ?? conv.id.slice(0, 8),
      title: conv.title ?? undefined,
      archived: conv.archived,
      replies,
    },
  };
}
