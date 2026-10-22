import { ceoOnStuck } from "./ceo-loop";
import type { HarnessCtx, SessionBinding } from "./ctx";

/**
 * D-#772: one place for the numbers. Six of the same call is a loop a
 * person would already have stopped — five can still be a retry. Twenty
 * minutes without a new step is a stall, not a slow tool. Any sign the
 * turn is moving resets that clock: a top-level tool call, and also a
 * streamed delta, a tool finishing, a nested tool, a subagent event, or
 * a background job starting or writing. The clock does not run while the
 * turn waits on the user (an open approval or question). Both marks clear
 * on a different step, a new message, or Stop (the callers). The phone's
 * Stuck notification is that phone's own preference and starts off.
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
 * over a quiet window: the loop is the more specific thing to say. The
 * quiet clock starts at the later of the last counted call, the turn's
 * start, and the last progress that wasn't itself a counted call. While
 * `waiting`, the quiet window does not run.
 */
export function stuckReason(input: {
  calls: StuckCall[];
  now: number;
  startedAt: number;
  progressAt?: number;
  waiting?: boolean;
}): string | undefined {
  const tail = identicalTail(input.calls);
  if (tail >= STUCK_REPEAT) {
    const last = input.calls.at(-1);
    if (last) return `Same ${toolWords(last.tool)} ${tail} times`;
  }
  if (input.waiting) return undefined;
  const lastCall = input.calls.at(-1)?.at;
  const lastAt = Math.max(
    lastCall ?? input.startedAt,
    input.startedAt,
    input.progressAt ?? 0,
  );
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

/** Drop the watch without writing. The caller's own patch clears the row.
    A replay in progress (`stuckDefer`) stays deferred. */
export function resetStuckWatch(binding: SessionBinding) {
  dropTimer(binding);
  binding.stuckCalls = [];
  binding.stuckSince = undefined;
  binding.stuckReason = undefined;
  binding.stuckProgress = undefined;
  binding.stuckPaused = false;
}

function publish(
  ctx: HarnessCtx,
  binding: SessionBinding,
  reason: string | undefined,
) {
  if (binding.stuckDefer) return;
  /* No reason: memory is empty after a restart while the row can still
     say stuck. `undefined === undefined` used to return here and leave
     that mark. The clear reads the row. */
  if (reason === undefined) {
    const had = binding.stuckReason !== undefined;
    binding.stuckReason = undefined;
    void persistClear(ctx, binding, had);
    return;
  }
  if (reason === binding.stuckReason) return;
  /* Wake once, on the transition into stuck. A longer streak ("7 times",
     "8 times") rewrites the card and must not wake again (D-#777). */
  const wasStuck = binding.stuckReason !== undefined;
  binding.stuckReason = reason;
  void ctx
    .updateConversation(binding.conversationId, {
      stuck: { reason },
    })
    .then(() => {
      if (!wasStuck) return ceoOnStuck(ctx, binding);
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
    progressAt: binding.stuckProgress,
    waiting: binding.stuckPaused === true,
  });
  publish(ctx, binding, reason);
}

/** A new step restarts the quiet window. Unref'd: a turn left running in
    a test must not keep the process alive for twenty minutes. */
function armQuiet(ctx: HarnessCtx, binding: SessionBinding) {
  dropTimer(binding);
  if (
    binding.stuckPaused ||
    binding.stuckDefer ||
    binding.stopRequested ||
    !binding.runningTurnId
  )
    return;
  const timer = setTimeout(() => {
    binding.stuckTimer = undefined;
    if (binding.stuckPaused || binding.stopRequested || !binding.runningTurnId)
      return;
    consider(ctx, binding, Date.now());
  }, STUCK_QUIET_MS);
  if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
  binding.stuckTimer = timer;
}

/** A turn started: the previous mark is cleared by that update's `stuck:
    null`. Arm the quiet window from now. During a replay, record only. */
export function beginStuckTurn(
  ctx: HarnessCtx,
  binding: SessionBinding,
  at = Date.now(),
) {
  /* A wait opened before this turn's `turn.started` (a replay raises
     open requests first) must stay paused. The map survives the reset. */
  const waiting = binding.nowWaits.size > 0;
  resetStuckWatch(binding);
  binding.stuckSince = at;
  binding.stuckPaused = waiting;
  armQuiet(ctx, binding);
}

/** A top-level tool call. Nested calls are progress — they reset the
    quiet window — but they don't count toward the repeat: the thread is
    stuck when its own step repeats. */
export function noteStuckTool(
  ctx: HarnessCtx,
  binding: SessionBinding,
  call: StuckCall,
  nested: boolean,
) {
  if (binding.stopRequested || !binding.runningTurnId) return;
  if (nested) {
    noteStuckProgress(ctx, binding, call.at);
    return;
  }
  const calls = binding.stuckCalls ?? [];
  calls.push(call);
  if (calls.length > CALL_CAP) calls.splice(0, calls.length - CALL_CAP);
  binding.stuckCalls = calls;
  if (binding.stuckDefer) return;
  consider(ctx, binding, call.at);
  if (!binding.stuckPaused) armQuiet(ctx, binding);
}

/** A streamed delta, a tool finishing, a nested tool, a subagent event,
    or a job starting or writing. Resets the quiet window. Not a repeat. */
export function noteStuckProgress(
  ctx: HarnessCtx,
  binding: SessionBinding,
  at = Date.now(),
) {
  if (binding.stopRequested || !binding.runningTurnId) return;
  binding.stuckProgress = at;
  if (binding.stuckDefer || binding.stuckPaused) return;
  consider(ctx, binding, at);
  armQuiet(ctx, binding);
}

/** An approval or a question is open: the quiet window does not run. */
export function pauseStuckWatch(ctx: HarnessCtx, binding: SessionBinding) {
  binding.stuckPaused = true;
  dropTimer(binding);
  if (binding.stuckDefer) return;
  consider(ctx, binding, Date.now());
}

/** The last wait closed. The time spent waiting is not quiet. */
export function resumeStuckWatch(
  ctx: HarnessCtx,
  binding: SessionBinding,
  at = Date.now(),
) {
  if (binding.nowWaits.size > 0) return;
  binding.stuckPaused = false;
  binding.stuckProgress = Math.max(binding.stuckProgress ?? 0, at);
  if (binding.stuckDefer || binding.stopRequested || !binding.runningTurnId)
    return;
  consider(ctx, binding, at);
  armQuiet(ctx, binding);
}

/** Replay records calls and progress, then judges once. A turn that is
    no longer running is not marked and not pushed; a mark left on the
    row from before the restart is cleared. */
export function finishStuckReplay(ctx: HarnessCtx, binding: SessionBinding) {
  binding.stuckDefer = false;
  if (binding.stopRequested || !binding.runningTurnId) {
    void clearStuck(ctx, binding);
    return;
  }
  if (binding.nowWaits.size > 0) {
    binding.stuckPaused = true;
    dropTimer(binding);
  }
  consider(ctx, binding, Date.now());
  if (!binding.stuckPaused) armQuiet(ctx, binding);
}

/** Stop, the session going away, or a restart that found a stale row:
    the mark leaves with the turn. Memory being empty is not "not stuck"
    — the row is read. */
export function clearStuck(
  ctx: HarnessCtx,
  binding: SessionBinding,
): Promise<void> {
  const had = binding.stuckReason !== undefined;
  resetStuckWatch(binding);
  return persistClear(ctx, binding, had);
}

async function persistClear(
  ctx: HarnessCtx,
  binding: SessionBinding,
  had: boolean,
) {
  let persisted = false;
  try {
    const cached = ctx.conversationFromAtom(binding.conversationId);
    const conv = cached ?? (await ctx.findConversation(binding.conversationId));
    persisted = conv?.stuck !== undefined;
  } catch (error) {
    ctx.opts.log.warn("stuck read failed", { error: String(error) });
    if (!had) return;
    persisted = true;
  }
  if (!had && !persisted) return;
  await ctx
    .updateConversation(binding.conversationId, { stuck: null })
    .catch((error) =>
      ctx.opts.log.warn("stuck clear failed", { error: String(error) }),
    );
}

/** A new message while the turn runs. The count starts over; the same
    loop can mark the thread again. A wait that is still open stays paused. */
export function stuckOnNewMessage(ctx: HarnessCtx, binding: SessionBinding) {
  const paused = binding.stuckPaused === true || binding.nowWaits.size > 0;
  void clearStuck(ctx, binding);
  if (!binding.runningTurnId || binding.stopRequested) return;
  binding.stuckSince = Date.now();
  binding.stuckPaused = paused;
  if (paused || binding.stuckDefer) return;
  armQuiet(ctx, binding);
}

/** `Harness.stop`: a quiet timer must not fire after the process stops. */
export function stopStuckWatches(bindings: Iterable<SessionBinding>) {
  for (const binding of bindings) resetStuckWatch(binding);
}
