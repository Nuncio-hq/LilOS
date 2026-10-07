import type {
  AppChannel,
  Conversation,
  ConversationLife,
  Employee,
  TurnFailure,
} from "@lilos/contracts/app";
import type { HarnessCtx } from "./ctx";

/**
 * Relay-view helpers: employee/conversation lookup and
 * writes plus deduped system notes (was the helpers tail of
 * `../harness.ts`).
 *
 * Moved verbatim out of `../harness.ts` (#441) — bodies byte-identical except each signature gained
 * `export function` + a `this: HarnessCtx` first parameter — `this` is
 * still the Harness: these functions sit on `Harness.prototype` via the
 * `Object.assign` at the bottom of `../harness.ts`.
 */

export function employeeIdFor(
  this: HarnessCtx,
  conv: Conversation | undefined,
) {
  if (!conv) return undefined;
  const channel: AppChannel | undefined = this.opts.relay.channels
    .get()
    .find((c) => c.id === conv.channelId);
  return channel?.employeeId;
}

export async function resolveEmployee(
  this: HarnessCtx,
  conv: Conversation | undefined,
): Promise<Employee | undefined> {
  const employeeId = this.employeeIdFor(conv);
  if (!employeeId) return undefined;
  const cached = this.opts.relay.employees
    .get()
    .find((e) => e.id === employeeId);
  if (cached) return cached;
  // Employees created after the harness connected are not in the atom.
  try {
    const { employees } = await this.opts.relay.request<{
      employees: Employee[];
    }>("employees.list", {});
    return employees.find((e) => e.id === employeeId);
  } catch {
    return undefined;
  }
}

export function conversationFromAtom(
  this: HarnessCtx,
  conversationId: string,
): Conversation | undefined {
  return this.opts.relay.conversations
    .get()
    .find((c) => c.id === conversationId);
}

export async function findConversation(
  this: HarnessCtx,
  conversationId: string,
): Promise<Conversation | undefined> {
  const found = this.conversationFromAtom(conversationId);
  if (found) return found;
  // conversation.updated is a live-only emit; a subscribe that lands after
  // the open races it away — so query the relay directly instead of only
  // trusting the atom. (AC-2/AC-4: first DM on a fresh channel, or events
  // missed while asleep, must still bind.)
  try {
    const listed = await this.opts.relay.request<{
      conversations: Conversation[];
    }>("conversations.list", {});
    const hit = listed.conversations.find((c) => c.id === conversationId);
    if (hit) return hit;
  } catch {
    return undefined;
  }
}

export async function updateConversation(
  this: HarnessCtx,
  conversationId: string,
  patch: {
    engineRef?: string;
    state?: "idle" | "active" | "closed";
    title?: string;
    model?: string | null;
    provider?: string | null;
    effort?: string | null;
    fast?: boolean | null;
    deliveredSeq?: number;
    life?: ConversationLife;
    /** #419: stamp the last turn's failure (DM alert card); `null`
        clears it. */
    turnFailure?: TurnFailure | null;
    /** #581: the thread's working folder — `conversations.moveFolder`
        writes it after re-homing the session; `null` clears it. */
    cwd?: string | null;
    /** #583: the last turn ended stopped (DM row word); `null` clears
        it on the next `turn.started`. */
    turnStopped?: boolean | null;
    /** #583: running background-job count (DM row badge + session-feed
        seed); `null` clears it. */
    bgJobs?: number | null;
  },
) {
  await this.opts.relay.request("conversations.update", {
    conversationId,
    ...patch,
  });
}

export async function postSystem(
  this: HarnessCtx,
  target: { channelId: string; conversationId: string },
  text: string,
  dedupeKey?: string,
) {
  this.relayWrite(`system note "${text.slice(0, 24)}"`, () =>
    this.opts.relay.request("messages.post", {
      channelId: target.channelId,
      conversationId: target.conversationId,
      authorKind: "system",
      text,
      ...(dedupeKey ? { dedupeKey } : {}),
    }),
  );
}
