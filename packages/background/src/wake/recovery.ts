import {
  type EngineEvent,
  EventsSinceResult,
  RPC_ERRORS,
  type SessionSnapshot,
  type StopReason,
} from "@lilos/contracts/engine";

/**
 * Wake/crash recovery against the engine protocol (AC-4, AC-5).
 *
 * SP2 verdict (spike #22) mapped onto this protocol: after a freeze the client
 * reconnects and replays `events.since` per in-flight turn. There is no
 * `session.activate`/orphan-reap here — a session either still exists on the
 * engine (resume watching events) or answers `SESSION_NOT_FOUND` (the engine
 * restarted without a persisted session — engine-fake has no store, Hermes
 * does), which is exactly the "interrupted by sleep" surface: never a spinner.
 */

/** Minimal request/response face of an engine connection. */
export interface EngineClient {
  request(method: string, params?: unknown): Promise<unknown>;
}

/** A session + the turn believed in flight when the connection dropped. */
export interface WatchedTurn {
  sessionId: string;
  turnId: string;
  /** Highest seq seen for this session before the drop. */
  lastSeq: number;
}

export type RecoveryVerdict =
  | {
      kind: "resumed";
      sessionId: string;
      turnId: string;
      /** Events missed while frozen, in seq order. */
      events: EngineEvent[];
      snapshot: SessionSnapshot;
    }
  | {
      kind: "completed";
      sessionId: string;
      turnId: string;
      stopReason: StopReason;
      events: EngineEvent[];
    }
  | {
      kind: "interrupted";
      sessionId: string;
      turnId: string;
      reason: "session_lost" | "replay_truncated" | "turn_lost";
      /** Per SP2: the turn can be re-prompted in place. Always true. */
      retry: true;
    };

interface WireError {
  code?: number;
}

function errorCode(e: unknown): number | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  return (e as WireError).code;
}

/**
 * Recover one session's in-flight turn after a reconnect:
 * - snapshot still shows the turn → `resumed` (watch it, nothing surfaces),
 * - a `turn.completed` arrived in the replayed gap → `completed`,
 * - replay truncated or the turn is gone without a completion → `interrupted`,
 * - `SESSION_NOT_FOUND` → the engine forgot the session → `interrupted`.
 */
export async function recoverTurn(
  conn: EngineClient,
  watched: WatchedTurn,
): Promise<RecoveryVerdict> {
  let res: EventsSinceResult;
  try {
    res = EventsSinceResult.parse(
      await conn.request("events.since", {
        sessionId: watched.sessionId,
        after: watched.lastSeq,
      }),
    );
  } catch (e) {
    if (errorCode(e) === RPC_ERRORS.SESSION_NOT_FOUND) {
      return {
        kind: "interrupted",
        sessionId: watched.sessionId,
        turnId: watched.turnId,
        reason: "session_lost",
        retry: true,
      };
    }
    throw e;
  }
  const completed = res.events.find(
    (e) =>
      e.type === "turn.completed" &&
      (e.payload as { turnId: string }).turnId === watched.turnId,
  );
  if (res.snapshot.turn?.turnId === watched.turnId) {
    return {
      kind: "resumed",
      sessionId: watched.sessionId,
      turnId: watched.turnId,
      events: res.events,
      snapshot: res.snapshot,
    };
  }
  if (completed && completed.type === "turn.completed") {
    return {
      kind: "completed",
      sessionId: watched.sessionId,
      turnId: watched.turnId,
      stopReason: completed.payload.stopReason,
      events: res.events,
    };
  }
  return {
    kind: "interrupted",
    sessionId: watched.sessionId,
    turnId: watched.turnId,
    reason: res.truncated ? "replay_truncated" : "turn_lost",
    retry: true,
  };
}

export interface RecoverySummary {
  /** One verdict per watched turn, in input order. */
  verdicts: RecoveryVerdict[];
  /** False when the sweep exceeded the orphan grace — caller should retry. */
  withinGrace: boolean;
}

/**
 * Recover every in-flight turn after a reconnect, bounded by the orphan grace
 * (SP2: ~20s on the Hermes gateway; engines may reap sessions whose client
 * vanished, so a slow sweep can silently lose turns).
 */
export async function recoverInFlight(
  conn: EngineClient,
  watched: readonly WatchedTurn[],
  opts: { orphanGraceMs?: number; now?: () => number } = {},
): Promise<RecoverySummary> {
  const now = opts.now ?? Date.now;
  const grace = opts.orphanGraceMs ?? 20_000;
  const start = now();
  // `events.since` calls are independent — recover in parallel so a slow
  // engine can't push later sessions past the orphan grace.
  const verdicts = await Promise.all(watched.map((w) => recoverTurn(conn, w)));
  return { verdicts, withinGrace: now() - start <= grace };
}
