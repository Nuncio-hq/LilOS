import type { Logger } from "./log";

/**
 * #346 AC-3 — the idle-session reaper. Once a minute it suspends every
 * bound engine session that has been quiet for `idleMs` (`0` = never).
 * Suspend, never stop: the session keeps its registry row, so the next
 * user message reopens it through `session.resume` (#288) before the
 * turn runs — "sending a message brings it back".
 *
 * Never while work can still land: a turn runs, an ask is open, a
 * subagent is running, or a send is anywhere between the relay and its
 * `turn.started`. The harness owns those judgments (its maps hold the
 * state); the reaper owns the clock and the `session.suspend` call.
 * Background jobs do NOT block it — that is the point: a `sleep` left
 * running dies with the suspend.
 */

/** What the reaper needs per bound session; the harness derives it. */
export interface ReaperCandidate {
  conversationId: string;
  sessionId: string;
  /** Epoch ms of the session's last engine event. */
  lastActivity: number;
}

export class SessionReaper {
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Re-entrancy guard: a slow `session.suspend` must not stack ticks. */
  private ticking = false;

  constructor(
    private readonly opts: {
      /** Suspend after this much quiet; 0 disables the reaper entirely. */
      idleMs: number;
      /** Check period — the AC's "checked every minute". */
      intervalMs: number;
      log: Logger;
      /** Live sessions eligible right now; anything with pending work is excluded. */
      candidates: () => ReaperCandidate[];
      /** `session.suspend` on the engine; throws when the engine can't. */
      suspend: (sessionId: string) => Promise<void>;
      /** Bookkeeping after a successful suspend (flag + `life: closed`). */
      onSuspended: (conversationId: string, sessionId: string) => void;
    },
  ) {}

  start() {
    if (this.opts.idleMs <= 0 || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass — suspended session ids; tests call it directly. */
  async tick(now = Date.now()): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const suspended: string[] = [];
    try {
      for (const c of this.opts.candidates()) {
        if (now - c.lastActivity < this.opts.idleMs) continue;
        try {
          await this.opts.suspend(c.sessionId);
          this.opts.onSuspended(c.conversationId, c.sessionId);
          suspended.push(c.sessionId);
          this.opts.log.info("idle session suspended", {
            conversationId: c.conversationId,
            sessionId: c.sessionId,
            idleMs: now - c.lastActivity,
          });
        } catch (error) {
          /* An engine that can't suspend keeps its session — the next
             message still lands; only the freeing of resources is lost. */
          this.opts.log.warn("idle suspend failed", {
            conversationId: c.conversationId,
            sessionId: c.sessionId,
            error: String(error),
          });
        }
      }
    } finally {
      this.ticking = false;
    }
    return suspended;
  }
}
