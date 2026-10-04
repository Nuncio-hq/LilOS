import type { Ask } from "@lilos/contracts/app";
import type { EngineRequest } from "@lilos/contracts/engine";
import { engineErrorCode } from "../engine/client";
import type { HarnessCtx, SessionBinding } from "./ctx";
import { waitLine } from "./now-line";
import { isTransientRelayError, REQUEST_NOT_FOUND } from "./rpc";

/**
 * Engine asks: relay ask cards, #106 full-access auto-approve,
 * the post-reconnect reconcile, and the resolved-ask forward (was the
 * asks cluster of `../harness.ts`).
 *
 * Moved verbatim out of `../harness.ts` (#441) — bodies byte-identical except each signature gained
 * `export function` + a `this: HarnessCtx` first parameter — `this` is
 * still the Harness: these functions sit on `Harness.prototype` via the
 * `Object.assign` at the bottom of `../harness.ts`.
 */

export async function openAsk(
  this: HarnessCtx,
  binding: SessionBinding,
  turnId: string,
  requestId: string,
  request: EngineRequest,
): Promise<void> {
  /* #422: the turn is parked on the user — the header reads "waiting on
     your approval" (replays through applyReplay land here too). */
  binding.nowWaits.set(requestId, waitLine(request));
  this.noteNow(binding);
  const key = `${binding.sessionId}:${requestId}`;
  const open = async () => {
    const result = await this.opts.relay.request<{ ask: Ask }>("asks.open", {
      channelId: binding.channelId,
      conversationId: binding.conversationId,
      turnId,
      requestId,
      request,
    });
    this.askByRequest.set(key, result.ask.id);
    this.requestByAsk.set(result.ask.id, {
      sessionId: binding.sessionId,
      requestId,
    });
    /* The relay dedupes a replayed open, and it can come back already
       resolved: the click landed while our socket was down, so the
       ask.resolved event never reached us (fire-and-forget). Forward it
       or the engine waits forever on an answer that already happened
       (#298). */
    if (result.ask.state === "resolved") {
      void this.onAskResolved(result.ask).catch((error) =>
        this.opts.log.warn("resolved ask forward failed", {
          askId: result.ask.id,
          error: String(error),
        }),
      );
    }
  };
  try {
    await open();
  } catch (error) {
    if (!isTransientRelayError(error)) throw error;
    // Socket mid-reconnect: the ask lands when the outbox flushes (the
    // request_id unique key makes a replayed open idempotent).
    this.relayWrite(`asks.open ${requestId}`, open);
  }
}

/**
 * #106 — Full access: answer an `approval` request ourselves with
 * `once` (the narrowest grant — no silent widening), never touching the
 * asks seam: no card, no push, no badge. The grant lands on the turn
 * feed as a system note so the action still reads as approved, not
 * vanished (AC-2). Deny-only cards (hardline blocks) answer their only
 * option — Full access can't bypass what the engine refuses to offer.
 */
export async function autoApprove(
  this: HarnessCtx,
  binding: SessionBinding,
  requestId: string,
  request: EngineRequest,
): Promise<void> {
  const conn = this.engine;
  if (!conn || request.kind !== "approval") return;
  const options = request.options;
  const outcome = options.includes("once") ? "once" : (options[0] ?? "once");
  try {
    await conn.request("request.respond", {
      sessionId: binding.sessionId,
      requestId,
      outcome,
    });
  } catch (error) {
    /* A cancel raced the auto-answer — the engine already closed it. */
    if (engineErrorCode(error) === REQUEST_NOT_FOUND) return;
    throw error;
  }
  const label =
    request.command && request.command !== "command"
      ? ` \`${request.command.slice(0, 120)}\``
      : "";
  await this.postSystem(
    binding,
    `Auto-approved${label} — Full access`,
    `sys:auto:${requestId}`,
  );
}

/**
 * After a relay reconnect, asks the user resolved while the socket was down
 * never reached us (`ask.resolved` is fire-and-forget). Re-list resolved
 * asks and forward the ones still mapped to an engine request.
 */
export async function reconcileAsks(this: HarnessCtx): Promise<void> {
  let resolved: Ask[];
  try {
    const res = await this.opts.relay.request<{ asks: Ask[] }>("asks.list", {
      state: "resolved",
    });
    resolved = res.asks;
  } catch (error) {
    this.opts.log.warn("asks reconcile failed", { error: String(error) });
    return;
  }
  for (const ask of resolved) {
    try {
      if (this.requestByAsk.has(ask.id) && ask.outcome)
        await this.onAskResolved(ask);
    } catch (error) {
      this.opts.log.warn("ask reconcile respond failed", {
        askId: ask.id,
        error: String(error),
      });
    }
  }
}

/** Engine resolved an ask itself (cancel/steer) → close the relay ask. */
export async function onEngineRequestResolved(
  this: HarnessCtx,
  sessionId: string,
  requestId: string,
  outcome: string,
  answer?: string,
) {
  const askId = this.askByRequest.get(`${sessionId}:${requestId}`);
  this.askByRequest.delete(`${sessionId}:${requestId}`);
  if (!askId) return;
  this.requestByAsk.delete(askId);
  this.relayWrite(`asks.respond ${requestId}`, () =>
    this.opts.relay.request("asks.respond", {
      askId,
      outcome,
      ...(answer ? { answer } : {}),
    }),
  );
}

export async function onAskResolved(this: HarnessCtx, ask: Ask) {
  const rec = this.requestByAsk.get(ask.id);
  if (!rec) return; // resolved engine-side already
  this.requestByAsk.delete(ask.id);
  this.askByRequest.delete(`${rec.sessionId}:${rec.requestId}`);
  const conn = this.engine;
  if (!conn) {
    // Engine detached mid-forward: keep the mapping so the next
    // reconcileAsks can retry — dropping it parks the turn forever.
    this.requestByAsk.set(ask.id, rec);
    this.askByRequest.set(`${rec.sessionId}:${rec.requestId}`, ask.id);
    return;
  }
  try {
    await conn.request("request.respond", {
      sessionId: rec.sessionId,
      requestId: rec.requestId,
      outcome: ask.outcome,
      ...(ask.answer ? { answer: ask.answer } : {}),
    });
  } catch (error) {
    if (engineErrorCode(error) !== REQUEST_NOT_FOUND) {
      // Same: a failed forward stays mapped so reconcileAsks retries it.
      this.requestByAsk.set(ask.id, rec);
      this.askByRequest.set(`${rec.sessionId}:${rec.requestId}`, ask.id);
      throw error;
    }
    this.opts.log.warn("engine request already gone", {
      requestId: rec.requestId,
    });
  }
}
