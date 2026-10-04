import { APP_PROTOCOL_VERSION, type PendingTurn } from "@lilos/contracts/app";
import type { HarnessCtx } from "./ctx";

/**
 * The `harness.register` handshake and the re-delivery sweep it
 * gates (was `onRelayReady` in `../harness.ts`).
 *
 * Moved verbatim out of `../harness.ts` (#441) — bodies byte-identical except each signature gained
 * `export function` + a `this: HarnessCtx` first parameter — `this` is
 * still the Harness: these functions sit on `Harness.prototype` via the
 * `Object.assign` at the bottom of `../harness.ts`.
 */

export async function onRelayReady(this: HarnessCtx): Promise<void> {
  if (!this.started) return;
  if (this.registering) {
    this.registerAgain = true;
    return;
  }
  this.registering = true;
  try {
    do {
      this.registerAgain = false;
      const reg = await this.opts.relay.request<{
        hostId: string;
        pending: PendingTurn[];
      }>("harness.register", {
        protocolVersion: APP_PROTOCOL_VERSION,
        version: this.opts.version ?? "0",
      });
      this.hostId = reg.hostId;
      this.opts.log.info("registered as engine host", {
        hostId: reg.hostId,
        pending: reg.pending.length,
      });
      // Queued writes land before any re-delivery: a pending turn whose
      // answer was in flight flushes first, and the watermark makes the
      // already-prompted tail ineligible a second time.
      await this.flushOutbox();
      await this.reconcileAsks();
      await this.sweepNow();
      for (const channel of this.opts.relay.channels.get()) {
        this.watchChannel(channel.id);
      }
      for (const turn of reg.pending) {
        for (const message of turn.messages ?? [turn.message]) {
          void this.deliver(message).catch((error) =>
            this.opts.log.error("pending turn delivery failed", {
              messageId: message.id,
              error: String(error),
            }),
          );
        }
      }
    } while (this.registerAgain);
  } finally {
    this.registering = false;
  }
}
