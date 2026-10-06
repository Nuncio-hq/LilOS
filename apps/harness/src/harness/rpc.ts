/**
 * Engine-call error codes and the relay-transport transient
 * classification shared by the moved modules (was the top-level
 * constants block of `../harness.ts`).
 *
 * Moved verbatim out of `../harness.ts` (#441) — `export` added to each declaration line.
 */

export const INVALID_STATE = -32003;
export const REQUEST_NOT_FOUND = -32002;
/** The engine forgot the session id (restart, retired row) — #581's move
    treats it as "no live session to re-home". */
export const SESSION_NOT_FOUND = -32001;
/** Tells the relay to answer the caller `engine_unavailable` (not error). */
export const ENGINE_UNAVAILABLE = -32005;
/** The engine's backend died under the call — restart surface, not a
    generic engine error (#521). */
export const BACKEND_DOWN = -32006;
/* #482: forwarded engine calls get their own deadline — a wedged adapter
   (or one whose backend died) must fail the caller fast typed instead of
   riding the transport's 15 s default. Longer than the probe's deadline so
   real traffic still distinguishes a dead adapter from a slow answer. */
export const ENGINE_CALL_DEADLINE_MS = 12_000;

/** Socket-level failures retry through the outbox; the rest are real. */
export const TRANSIENT_CODES = new Set([
  "not_connected",
  "timeout",
  "socket_closed",
  "closed",
]);
export function isTransientRelayError(error: unknown): boolean {
  if (error instanceof Error && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  }
  return false;
}
