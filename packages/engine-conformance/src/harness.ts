import type { EngineEvent } from "@lilos/contracts/engine";

/**
 * The suite's view of an engine: request/response plus the push stream. Both
 * engine-fake transports (in-memory, WebSocket) satisfy this; a real engine
 * adapter needs the same two methods.
 */
export interface EngineConnection {
  request(method: string, params?: unknown): Promise<unknown>;
  onEvent(fn: (e: EngineEvent) => void): () => void;
  close(): void;
}

const DEFAULT_TIMEOUT = 10_000;

interface Waiter {
  pred: (e: EngineEvent) => boolean;
  resolve: (e: EngineEvent) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Collects the event stream and lets scenarios await specific frames. */
export class Harness {
  readonly events: EngineEvent[] = [];
  private waiters: Waiter[] = [];

  constructor(
    readonly conn: EngineConnection,
    private readonly timeout = DEFAULT_TIMEOUT,
  ) {
    conn.onEvent((e) => {
      this.events.push(e);
      const hit = this.waiters.findIndex((w) => w.pred(e));
      if (hit >= 0) {
        const [w] = this.waiters.splice(hit, 1);
        clearTimeout(w.timer);
        w.resolve(e);
      }
    });
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    return this.conn.request(method, params);
  }

  /** Next event matching `pred`, whether already seen or still coming. */
  waitEvent(
    pred: (e: EngineEvent) => boolean,
    timeout = this.timeout,
  ): Promise<EngineEvent> {
    const seen = this.events.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(
          new Error(
            `timed out waiting for event; seen: ${this.events.map((e) => e.type).join(", ") || "(none)"}`,
          ),
        );
      }, timeout);
      this.waiters.push({ pred, resolve, reject, timer });
    });
  }

  forSession(
    sessionId: string,
    pred: (e: EngineEvent) => boolean = () => true,
  ) {
    return (e: EngineEvent) => e.sessionId === sessionId && pred(e);
  }

  close() {
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error("harness closed"));
    }
    this.conn.close();
  }
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assert: ${msg}`);
}

/** Assert seq values are strictly increasing per event list order. */
export function assertMonotonic(events: EngineEvent[]) {
  for (let i = 1; i < events.length; i++) {
    assert(
      events[i].seq > events[i - 1].seq,
      `seq not monotonic at index ${i}: ${events[i].seq} <= ${events[i - 1].seq}`,
    );
  }
}
