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
export function ageLabel(createdAt: number, nowMs: number): string {
  const mins = Math.max(1, Math.round((nowMs - createdAt) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
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
    reason:
      request.kind === "question"
        ? request.question
        : (request.description ?? "Wants your approval"),
    command: request.kind === "approval" ? request.command : undefined,
    age: ageLabel(ask.createdAt, nowMs),
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
  const oldest = pending[0];
  if (oldest !== undefined) {
    return {
      ...base,
      state: "needs-you",
      now:
        pending.length === 1
          ? `Waiting on you · ${sessionLabel(oldest.conversationId, wire)}`
          : `${pending.length} need you`,
      when: ageLabel(oldest.createdAt, nowMs),
    };
  }
  if (live !== undefined) {
    return {
      ...base,
      state: "working",
      now: sessionLabel(live.id, wire),
      when: "now",
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
