import type {
  AppChannel,
  Conversation,
  ConversationLife,
  Employee,
  TurnFailure,
} from "@lilos/contracts/app";
import {
  DEFAULT_RUNTIME,
  normalizeRuntime,
  parseSessionRef,
} from "../engine/runtimes";
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

/* D-#761: the runtime a conversation binds to — the stored engineRef's
   qualifier wins (the session demonstrably lives there), else the
   channel employee's persisted `runtime` via `resolveEmployee` (atom
   first, `employees.list` fallback — a just-hired employee is not in
   the atom yet). */
export async function runtimeForConversation(
  this: HarnessCtx,
  conv: Conversation | undefined,
): Promise<string> {
  if (!conv) return DEFAULT_RUNTIME;
  if (conv.engineRef) return parseSessionRef(conv.engineRef).runtime;
  const employee = await this.resolveEmployee(conv);
  return normalizeRuntime(employee?.runtime);
}

export async function runtimeFailureDetail(
  this: HarnessCtx,
  conv: Conversation | undefined,
): Promise<string | undefined> {
  if (!conv) return undefined;
  const inst = this.runtimes?.get(await this.runtimeForConversation(conv));
  /* `failedAt`, not `state`: the row may already be RELEASED back to
     `idle` by the time a just-failed bind parks its send — the verdict
     that bind observed is what matters. */
  return inst?.failedAt !== undefined
    ? (inst.detail ?? `engine ${inst.spec.label} failed`)
    : undefined;
}

/* Terminal-failure gating is a NON-DEFAULT-runtime semantic (D-#761
   review): a lazily-started coding-agent runtime that cannot launch
   settles its parked sends visibly instead of parking forever. The
   default engine keeps its park-until-recovery behavior — its
   supervisor still owns restarts, and a transient death (sleep,
   crash) must not error a send that a recovery would deliver. */
export async function runtimeFailedFor(
  this: HarnessCtx,
  conv: Conversation | undefined,
): Promise<boolean> {
  if (!conv) return false;
  return (
    (await this.runtimeForConversation(conv)) !== DEFAULT_RUNTIME &&
    (await this.runtimeFailureDetail(conv)) !== undefined
  );
}

/* D-#761 review: a failed non-default runtime keeps a supervisor (and
   the temptation to re-drive it) only while something still wants it —
   a bound session, a parked send, or a caller in `ensure`. Once the
   last of those is gone the row idles; the next real demand starts it
   fresh with a full crash budget. */
export async function releaseIdleFailedRuntimes(
  this: HarnessCtx,
): Promise<void> {
  const runtimes = this.runtimes;
  if (!runtimes) return;
  for (const inst of runtimes.list()) {
    const id = inst.spec.id;
    if (id === DEFAULT_RUNTIME || inst.state !== "failed") continue;
    if (inst.waiters.length) continue;
    if ([...this.bindings.values()].some((b) => b.runtime === id)) continue;
    let parked = false;
    for (const convId of this.early.keys()) {
      const conv = await this.findConversation(convId);
      if (conv && (await this.runtimeForConversation(conv)) === id) {
        parked = true;
        break;
      }
    }
    if (parked) continue;
    await runtimes.release(id).catch((error) =>
      this.opts.log.warn("runtime release failed", {
        runtime: id,
        error: String(error),
      }),
    );
  }
}

export async function findConversation(
  this: HarnessCtx,
  conversationId: string,
): Promise<Conversation | undefined> {
  const found = this.conversationFromAtom(conversationId);
  if (found) return found;
  // conversation.updated is a live-only emit; a subscribe that lands after
  // the open races it away — so query the relay directly instead of only
  // trusting the atom. (AC-2/AC-4: first thread on a fresh channel, or events
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
    /** #419: stamp the last turn's failure (thread alert card); `null`
        clears it. */
    turnFailure?: TurnFailure | null;
    /** #581: the thread's working folder — `conversations.moveFolder`
        writes it after re-homing the session; `null` clears it. */
    cwd?: string | null;
    /** #583: the last turn ended stopped (thread row word); `null` clears
        it on the next `turn.started`. */
    turnStopped?: boolean | null;
    /** #583: running background-job count (thread row badge + session-feed
        seed); `null` clears it. */
    bgJobs?: number | null;
    /** D-#772: the running turn is stuck; `null` clears it. */
    stuck?: { reason: string } | null;
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
