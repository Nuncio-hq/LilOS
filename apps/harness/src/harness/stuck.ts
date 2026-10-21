import type { HarnessCtx, SessionBinding } from "./ctx";

/**
 * D-#772: one place for the numbers. Six of the same call is a loop a
 * person would already have stopped — five can still be a retry. Twenty
 * minutes without a new step is a stall, not a slow tool: a step that
 * starts resets the clock. Both marks clear on a different step, a new
 * message, or Stop (the callers).
 */
export const STUCK_REPEAT = 6;
export const STUCK_QUIET_MS = 20 * 60 * 1000;

/** Enough tail to name a long streak; a turn that loops forever doesn't
    keep every call. */
const CALL_CAP = 32;

export interface StuckCall {
  tool: string;
  input: unknown;
  at: number;
}

/** "web_search" / "WebSearch" → "web search", the words the card says. */
export function toolWords(tool: string): string {
  const words = tool
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\s-]+/g, " ")
    .trim()
    .toLowerCase();
  return words || "tool";
}

/** Same tool and the same arguments, in a row, from the newest call back. */
function identicalTail(calls: StuckCall[]): number {
  const last = calls.at(-1);
  if (!last) return 0;
  const key = stable(last.input);
  let n = 0;
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (!call || call.tool !== last.tool || stable(call.input) !== key) break;
    n += 1;
  }
  return n;
}

/** Key order doesn't make two calls different. */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
    .join(",")}}`;
}

/**
 * The plain reason, or nothing when the turn is moving. A repeat wins
 * over a quiet window: the loop is the more specific thing to say.
 */
export function stuckReason(input: {
  calls: StuckCall[];
  now: number;
  startedAt: number;
}): string | undefined {
  const tail = identicalTail(input.calls);
  if (tail >= STUCK_REPEAT) {
    const last = input.calls.at(-1);
    if (last) return `Same ${toolWords(last.tool)} ${tail} times`;
  }
  const lastAt = input.calls.at(-1)?.at ?? input.startedAt;
  const quiet = input.now - lastAt;
  if (quiet >= STUCK_QUIET_MS) {
    const mins = Math.floor(quiet / 60_000);
    return `No new step for ${mins} minutes`;
  }
  return undefined;
}

function dropTimer(binding: SessionBinding) {
  if (binding.stuckTimer) clearTimeout(binding.stuckTimer);
  binding.stuckTimer = undefined;
}

/** Drop the watch without writing. The caller's own patch clears the row. */
export function resetStuckWatch(binding: SessionBinding) {
  dropTimer(binding);
  binding.stuckCalls = [];
  binding.stuckSince = undefined;
  binding.stuckReason = undefined;
}

function publish(
  ctx: HarnessCtx,
  binding: SessionBinding,
  reason: string | undefined,
) {
  if (reason === binding.stuckReason) return;
  if (!reason && binding.stuckReason === undefined) return;
  binding.stuckReason = reason;
  void ctx
    .updateConversation(binding.conversationId, {
      stuck: reason ? { reason } : null,
    })
    .catch((error) =>
      ctx.opts.log.warn("stuck write failed", { error: String(error) }),
    );
}

function consider(ctx: HarnessCtx, binding: SessionBinding, now: number) {
  const reason = stuckReason({
    calls: binding.stuckCalls ?? [],
    now,
    startedAt: binding.stuckSince ?? now,
  });
  publish(ctx, binding, reason);
}

/** A new step restarts the quiet window. Unref'd: a turn left running in
    a test must not keep the process alive for twenty minutes. */
function armQuiet(ctx: HarnessCtx, binding: SessionBinding) {
  dropTimer(binding);
  if (binding.stopRequested || !binding.runningTurnId) return;
  const timer = setTimeout(() => {
    binding.stuckTimer = undefined;
    if (binding.stopRequested || !binding.runningTurnId) return;
    consider(ctx, binding, Date.now());
  }, STUCK_QUIET_MS);
  if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
  binding.stuckTimer = timer;
}

/** A turn started: the previous mark is cleared by that update's `stuck:
    null`. Arm the quiet window from now. */
export function beginStuckTurn(
  ctx: HarnessCtx,
  binding: SessionBinding,
  at = Date.now(),
) {
  resetStuckWatch(binding);
  binding.stuckSince = at;
  armQuiet(ctx, binding);
}

/** A top-level tool call. Nested calls (a helper's own steps) don't
    count: the thread is stuck when its own step repeats. */
export function noteStuckTool(
  ctx: HarnessCtx,
  binding: SessionBinding,
  call: StuckCall,
  nested: boolean,
) {
  if (nested || binding.stopRequested || !binding.runningTurnId) return;
  const calls = binding.stuckCalls ?? [];
  calls.push(call);
  if (calls.length > CALL_CAP) calls.splice(0, calls.length - CALL_CAP);
  binding.stuckCalls = calls;
  consider(ctx, binding, call.at);
  armQuiet(ctx, binding);
}

/** Stop, or the session going away: the mark leaves with the turn. */
export function clearStuck(ctx: HarnessCtx, binding: SessionBinding) {
  const had = binding.stuckReason;
  resetStuckWatch(binding);
  if (had)
    void ctx
      .updateConversation(binding.conversationId, { stuck: null })
      .catch((error) =>
        ctx.opts.log.warn("stuck clear failed", { error: String(error) }),
      );
}

/** A new message while the turn runs. The count starts over; the same
    loop can mark the thread again. */
export function stuckOnNewMessage(ctx: HarnessCtx, binding: SessionBinding) {
  clearStuck(ctx, binding);
  if (!binding.runningTurnId || binding.stopRequested) return;
  binding.stuckSince = Date.now();
  armQuiet(ctx, binding);
}
