import type { HarnessCtx } from "./ctx";
import { isTransientRelayError } from "./rpc";

/**
 * The outbox: a relay write either lands now or queues FIFO and
 * replays on the next `harness.register` (was the `relayWrite`/
 * `flushOutbox` pair in `../harness.ts`).
 *
 * Moved verbatim out of `../harness.ts` (#441) — bodies byte-identical except each signature gained
 * `export function` + a `this: HarnessCtx` first parameter — `this` is
 * still the Harness: these functions sit on `Harness.prototype` via the
 * `Object.assign` at the bottom of `../harness.ts`.
 */

/**
 * One relay write. Transient failures (socket down/timeout) queue into the
 * outbox and replay in order on the next registration; permanent failures
 * (not_found/forbidden) are dropped with a log.
 */
export function relayWrite(
  this: HarnessCtx,
  label: string,
  run: () => Promise<unknown>,
): void {
  if (this.outbox.length > 0) {
    // Keep FIFO order: never overtake a queued write.
    this.outbox.push({ label, run });
    return;
  }
  void run().catch((error) => {
    if (isTransientRelayError(error)) {
      this.outbox.push({ label, run });
    } else {
      this.opts.log.warn(`${label} dropped`, { error: String(error) });
    }
  });
}

export async function flushOutbox(this: HarnessCtx): Promise<void> {
  if (this.flushingOutbox) return;
  this.flushingOutbox = true;
  try {
    while (this.outbox.length > 0) {
      const entry = this.outbox[0];
      try {
        await entry.run();
        this.outbox.shift();
      } catch (error) {
        if (!isTransientRelayError(error)) {
          this.opts.log.warn(`${entry.label} dropped on retry`, {
            error: String(error),
          });
          this.outbox.shift();
          continue;
        }
        break; // socket down again — retry on the next register
      }
    }
  } finally {
    this.flushingOutbox = false;
  }
}
