/**
 * CEO wake thresholds (D-#777). One place, with the why.
 *
 * A finish, the waiters it unblocks, and a stuck mark arrive as separate
 * relay events a few hundred milliseconds apart. 1.5s gathers that burst
 * into one wake. Longer and the owner watches a quiet Home. Shorter and
 * one burst becomes several turns.
 *
 * The CEO's own writes carry their employee id and are dropped. With no
 * CEO, nothing is queued. At most one turn runs; events that arrive during
 * it leave together when it goes idle, because they already waited.
 */
export const CEO_WAKE_COALESCE_MS = 1_500;

export type CeoWakeReason = "done" | "stuck" | "ask" | "schedule";

export interface CeoWakeEvent {
  reason: CeoWakeReason;
  ticketId?: string;
  goalId?: string;
  /** Who wrote the ticket. Equal to the CEO → the CEO's own action. */
  actorId?: string;
  /** Another employee a stuck thread should be handed to. */
  handTo?: string;
  /** Tickets waiting on a finish, with the owner to move them to. */
  next?: { ticketId: string; ownerId: string }[];
  text?: string;
  taskId?: string;
  at: number;
}

export type CeoWakeNote = "no-ceo" | "self" | "queued";

export class CeoWakes {
  private pending: CeoWakeEvent[] = [];
  private windowAt = 0;
  private running = false;

  note(event: CeoWakeEvent, ceoId: string | null): CeoWakeNote {
    if (!ceoId) return "no-ceo";
    if (event.actorId !== undefined && event.actorId === ceoId) return "self";
    if (this.pending.length === 0) this.windowAt = event.at;
    this.pending.push(event);
    return "queued";
  }

  /** Null while a turn is running, or the window has not closed. */
  poll(now: number): CeoWakeEvent[] | null {
    if (this.running || this.pending.length === 0) return null;
    if (now - this.windowAt < CEO_WAKE_COALESCE_MS) return null;
    return this.take();
  }

  /**
   * The turn went idle. The next wake leaves immediately: those events
   * already waited through the turn, so they do not open a new window.
   */
  settled(): CeoWakeEvent[] | null {
    this.running = false;
    if (this.pending.length === 0) return null;
    return this.take();
  }

  /** A failed delivery must not leave the queue stuck running. */
  fail(): void {
    this.running = false;
  }

  /** Drop what has not started. A running turn is left to finish. */
  clear(): void {
    this.pending = [];
    this.windowAt = 0;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** Ms until `poll` can take the batch. Zero when nothing is waiting. */
  remaining(now: number): number {
    if (this.pending.length === 0 || this.running) return 0;
    return Math.max(0, this.windowAt + CEO_WAKE_COALESCE_MS - now);
  }

  private take(): CeoWakeEvent[] {
    const out = this.pending;
    this.pending = [];
    this.windowAt = 0;
    this.running = true;
    return out;
  }
}

/** The user message a standing CEO thread reads. One line per event. */
export function formatCeoWake(events: readonly CeoWakeEvent[]): string {
  const lines = ["CEO wake."];
  for (const event of events) {
    if (event.reason === "done" && event.ticketId) {
      lines.push(`- finished ${event.ticketId}`);
      for (const next of event.next ?? []) {
        lines.push(`- next ${next.ticketId} owner ${next.ownerId}`);
      }
    } else if (event.reason === "stuck" && event.ticketId && event.handTo) {
      lines.push(`- stuck ticket ${event.ticketId} hand ${event.handTo}`);
    } else if (event.reason === "ask" && event.ticketId) {
      lines.push(`- ask ticket ${event.ticketId}`);
    } else if (event.reason === "schedule") {
      const text = (event.text ?? "").replace(/\s+/g, " ").trim();
      lines.push(`- schedule ${text}`.trimEnd());
    }
  }
  return lines.join("\n");
}
