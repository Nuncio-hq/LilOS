import type {
  AppChannel,
  Ask,
  Conversation,
  ConversationSummary,
  Employee,
} from "@lilos/contracts/app";
import type { Approval, EmployeeRow } from "@lilos/ui-native";
import { toneOf } from "./mapping";

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

/** The one DM channel an employee owns (`channels.openDm` is get-or-create). */
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
  const text = summary?.root.text.trim();
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

/** #595: where a plan ask's **Review** lands — the employee's DM pushed
    under the asking thread (Back returns to the DM). Undefined when the
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
    age: ageLabel(ask.createdAt, nowMs),
    /* #591 AC-2: an offline Activity keeps its rows — each says "last
       known" instead of pretending they were just fetched. */
    ...(wire.online ? {} : { lastKnown: true as const }),
  };
}

/**
 * An employee as a Home row: any open ask on its DM channel wins over an
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
  const base = { id: e.id, name: e.name, role: e.role, tone: toneOf(e.id) };
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
          ? `Waiting on you · ${sessionLabel(oldest.conversationId, wire)}`
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
 * subscribes every DM channel. `channelMessages` is idempotent and its
 * subscription intent survives reconnects — safe to call on every refresh.
 */
export function ensureChannelSubscriptions(
  client: ChannelSubscriber,
  channels: AppChannel[],
): void {
  for (const channel of channels) client.channelMessages(channel.id);
}
