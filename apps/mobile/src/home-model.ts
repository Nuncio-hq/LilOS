import type {
  AppChannel,
  Ask,
  Conversation,
  ConversationSummary,
  Employee,
  Project,
} from "@lilos/contracts/app";
import { ceoWakeNote } from "@lilos/contracts/harness";
import type {
  Approval,
  EmployeeRow,
  SessionListGroups,
} from "@lilos/ui-native";
import { projectNameOf, toneOf } from "./mapping";

/**
 * Home's derivation from wire data (#155): the relay's employees/channels/
 * conversations/asks lists become the EmployeeRow and Approval view models
 * ui-native renders. Pure and unit-tested — the screens in `screens/home.tsx`
 * only feed atoms in and navigate out. `nowMs` is a parameter so tests and
 * re-renders never depend on wall-clock tricks.
 */
export type HomeWire = {
  employees: Employee[];
  channels: AppChannel[];
  conversations: Conversation[];
  /* D-#771: the thread rows' project labels. */
  projects: Project[];
  summaries: ConversationSummary[];
  asks: Ask[];
  /* #591: false = everything below is last-known (cached) state — rows
     must say so instead of looking live. */
  online: boolean;
};

/** Every open ask, oldest first — the order Activity lists them. */
export function openAsks(asks: Ask[]): Ask[] {
  return asks
    .filter((a) => a.state === "open")
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** The one per-agent channel an employee owns (`channels.openDm` is
    get-or-create). The wire keeps the `dm` name for compatibility; the
    channel is internal routing, never shown as a DM (D-#771). */
export function dmChannelFor(
  channels: AppChannel[],
  employeeId: string,
): AppChannel | undefined {
  return channels.find((c) => c.kind === "dm" && c.employeeId === employeeId);
}

/** What a thread is called: its title, else the prompt that opened it. */
function sessionLabel(conversationId: string, wire: HomeWire): string {
  const conversation = wire.conversations.find((c) => c.id === conversationId);
  if (conversation?.title) return conversation.title;
  const summary = wire.summaries.find(
    (s) => s.conversation.id === conversationId,
  );
  const raw = summary?.root.ceoWake
    ? ceoWakeNote(summary.root.text)
    : summary?.root.text;
  const text = raw?.trim();
  if (text) return text.length > 40 ? `${text.slice(0, 39)}…` : text;
  return "a thread";
}

/** "2m" / "1h" / "1d" — relative age the rows render (`when`, `age`). */
function ageLabel(createdAt: number, nowMs: number): string {
  const mins = Math.max(1, Math.round((nowMs - createdAt) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** #595: where a plan ask's **Review** lands — the employee's thread list
    pushed under the asking thread (Back returns to it). Undefined when the
    ask's channel is gone from the wire — the surface falls back to
    Activity instead of a dead end. */
export function askThreadTarget(
  ask: Pick<Ask, "channelId" | "conversationId">,
  wire: Pick<HomeWire, "channels">,
): { employeeId: string; conversationId: string } | undefined {
  const employeeId = wire.channels.find(
    (c) => c.id === ask.channelId,
  )?.employeeId;
  if (!employeeId) return undefined;
  return { employeeId, conversationId: ask.conversationId };
}

/** #596: where a push/deep link lands — the employee's thread list pushed
   under the thread, the same landing an ask's Open/Review takes (Back
   returns to the list). Undefined while the wire can't name the
   conversation's employee — the caller then pushes Thread alone and its
   loading/gone states cover the gap. */
export function deepThreadTarget(
  conversationId: string,
  wire: Pick<HomeWire, "channels" | "conversations">,
): { employeeId: string; conversationId: string } | undefined {
  const channelId = wire.conversations.find(
    (c) => c.id === conversationId,
  )?.channelId;
  const employeeId = channelId
    ? wire.channels.find((c) => c.id === channelId)?.employeeId
    : undefined;
  if (!employeeId) return undefined;
  return { employeeId, conversationId };
}

/** An open ask as an Activity/accessory row. */
export function toApproval(ask: Ask, wire: HomeWire, nowMs: number): Approval {
  const channel = wire.channels.find((c) => c.id === ask.channelId);
  const employee = wire.employees.find((e) => e.id === channel?.employeeId);
  const request = ask.request;
  return {
    id: ask.id,
    employeeId: employee?.id ?? "",
    employee: employee?.name ?? "Someone",
    tone: employee ? toneOf(employee.id) : "stone",
    session: sessionLabel(ask.conversationId, wire),
    kind: request.kind,
    /* #595: a plan's primary pill is **Review** — it opens the plan in its
       thread; no surface approves a plan sight-unseen. Command approvals
       keep the one-tap **Approve** (AC-2); a question has no primary pill
       (it needs an answer, not an OK). */
    primary:
      request.kind === "plan"
        ? "review"
        : request.kind === "approval"
          ? "approve"
          : undefined,
    /* #264: like askReason — the reason is the command; the row's sentence
       ("<employee> wants to run") is composed on the surface. */
    reason:
      request.kind === "question"
        ? request.question
        : request.kind === "plan"
          ? "Plan waiting for your review"
          : request.command,
    command: request.kind === "approval" ? request.command : undefined,
    /* #601: the ask's own options ride the row — the card + sheet offer
       Once / This session / Always / Deny as it asked them. */
    grantOptions: request.kind === "approval" ? request.options : undefined,
    /* #553: a question ask carries its answer buttons + free-text flag —
       the Activity card renders the same QuestionCard the thread does. */
    options: request.kind === "question" ? request.options : undefined,
    freeText: request.kind === "question" ? request.freeText : undefined,
    age: ageLabel(ask.createdAt, nowMs),
    /* #591 AC-2: an offline Activity keeps its rows — each says "last
       known" instead of pretending they were just fetched. */
    ...(wire.online ? {} : { lastKnown: true as const }),
  };
}

/**
 * An employee as a Home row: any open ask on its channel wins over an
 * active turn, which wins over the stored `status`/`now` the relay keeps.
 * Several asks collapse to "N need you" like the prototype's `statusOf`.
 */
export function toEmployeeRow(
  e: Employee,
  wire: HomeWire,
  nowMs: number,
): EmployeeRow {
  const channel = dmChannelFor(wire.channels, e.id);
  const pending = openAsks(wire.asks).filter(
    (a) => a.channelId === channel?.id,
  );
  const live = wire.conversations.find(
    (c) => c.state === "active" && !c.archived && c.channelId === channel?.id,
  );
  const base = {
    id: e.id,
    name: e.name,
    role: e.role,
    tone: toneOf(e.id),
    /* #563: any of this agent's threads finished past the read watermark
       dots the employee — opening the thread clears it on every device. */
    unseen:
      (channel !== undefined &&
        wire.conversations.some(
          (c) =>
            c.channelId === channel.id &&
            !c.archived &&
            !c.ceoThread &&
            c.finishedSeq > c.readSeq,
        )) ||
      undefined,
  };
  /* #591 AC-2: live-looking states read "Last known · …" — the marker
     FIRST, so truncation can never cut it off — and the row carries
     `lastKnown` so the screen dims the live tint (no teal line, no
     working dots, no state ring on the orb). The idle fallback needs no
     mark: "Idle" never looks live. */
  const stale = !wire.online;
  const staleNote = stale ? "Last known · " : "";
  const oldest = pending[0];
  if (oldest !== undefined) {
    return {
      ...base,
      state: "needs-you",
      now:
        staleNote +
        (pending.length === 1
          ? `Needs you · ${sessionLabel(oldest.conversationId, wire)}`
          : `${pending.length} need you`),
      when: ageLabel(oldest.createdAt, nowMs),
      ...(stale ? { lastKnown: true as const } : {}),
    };
  }
  if (live !== undefined) {
    return {
      ...base,
      state: "working",
      now: staleNote + sessionLabel(live.id, wire),
      when: "now",
      ...(stale ? { lastKnown: true as const } : {}),
    };
  }
  return {
    ...base,
    state: "idle",
    now: e.now || (e.status === "offline" ? "Offline" : "Idle"),
    when: "",
  };
}

/* The smallest surface a RelayClient has to give Home for live updates. */
export interface ChannelSubscriber {
  channelMessages(channelId: string): unknown;
}

/**
 * `channel.subscribe` is the only relay path `ask.opened`/`ask.resolved`/
 * `conversation.updated`/`message.created` notifications ride on, so Home
 * subscribes every per-agent channel. `channelMessages` is idempotent and its
 * subscription intent survives reconnects — safe to call on every refresh.
 */
export function ensureChannelSubscriptions(
  client: ChannelSubscriber,
  channels: AppChannel[],
): void {
  for (const channel of channels) client.channelMessages(channel.id);
}

/* The cross-agent thread list (web: sessions.ts / SessionsHome): every
   non-archived thread in one list — open asks first ("needs you"), then
   active threads ("working"), then the rest, with the unread watermark
   (finishedSeq > readSeq) leading "recently finished". The group split
   follows the same rules `toEmployeeRow` applies per employee, so the
   needs-you count is the sum of the employee ask rows. */
export function toSessionGroups(
  wire: HomeWire,
  nowMs: number,
): SessionListGroups {
  const asksByConv = new Map<string, Ask[]>();
  for (const a of openAsks(wire.asks)) {
    const list = asksByConv.get(a.conversationId) ?? [];
    list.push(a);
    asksByConv.set(a.conversationId, list);
  }
  const empByChannel = new Map(
    wire.channels
      .filter((c) => c.kind === "dm")
      .map((c) => [c.id, c.employeeId] as const),
  );
  const empById = new Map(wire.employees.map((e) => [e.id, e] as const));
  const lastOf = (id: string) =>
    wire.summaries.find((s) => s.conversation.id === id)?.last.createdAt ?? 0;
  const out: SessionListGroups = { needsYou: [], running: [], finished: [] };
  for (const c of wire.conversations) {
    if (c.archived) continue;
    const employeeId = empByChannel.get(c.channelId);
    const employee = employeeId ? empById.get(employeeId) : undefined;
    if (!employee) continue;
    const ask = asksByConv.get(c.id)?.[0];
    const project = projectNameOf(c, wire.projects);
    const base = {
      id: c.id,
      employeeId: employee.id,
      employeeName: employee.name,
      tone: toneOf(employee.id),
      title: sessionLabel(c.id, wire),
      ...(project ? { project } : {}),
      when: ageLabel(lastOf(c.id) || c.createdAt, nowMs),
      /* D-#777: the standing thread never counts as unseen. */
      unread: c.finishedSeq > c.readSeq && !c.ceoThread,
    };
    if (ask) {
      const req = ask.request;
      out.needsYou.push({
        ...base,
        state: "needs-you",
        live:
          req.kind === "question"
            ? `Question: ${req.question ?? ""}`
            : req.kind === "plan"
              ? "Plan review"
              : `Approve${req.command ? `: ${req.command}` : ""}`,
        unread: false,
      });
    } else if (c.state === "active") {
      out.running.push({
        ...base,
        state: "working",
        live: employee.now || undefined,
        unread: false,
      });
    } else {
      out.finished.push({
        ...base,
        state: c.turnFailure ? "failed" : c.turnStopped ? "stopped" : "done",
      });
    }
  }
  out.finished.sort(
    (a, b) => Number(b.unread ?? false) - Number(a.unread ?? false),
  );
  return out;
}
