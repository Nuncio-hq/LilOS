import type { Conversation } from "@lilos/contracts/app";
import type { EventsSinceResult } from "@lilos/contracts/engine";
import type {
  ConversationPickPatch,
  HarnessCtx,
  ModelPick,
  SessionBinding,
} from "./ctx";

/**
 * Model picks (#30/#92): conversation-level picks, held
 * mid-turn picks, and the engine-ack correction path (was the model-pick
 * cluster of `../harness.ts`).
 *
 * Moved verbatim out of `../harness.ts` (#441) — bodies byte-identical except each signature gained
 * `export function` + a `this: HarnessCtx` first parameter — `this` is
 * still the Harness: these functions sit on `Harness.prototype` via the
 * `Object.assign` at the bottom of `../harness.ts`.
 */

/**
 * Model pick (#30): `conversations.setModel` lands here. With a bound
 * engine session the engine acks first (its canonical id is what the
 * conversation stores); without one the pin rides on the conversation and
 * `session.start` picks it up via `sessionParams`.
 */
export async function onModelRequested(
  this: HarnessCtx,
  conversationId: string,
  pick: ModelPick,
) {
  const binding = this.bindings.get(conversationId);
  const conn = this.engine;
  /* The pick is the whole intended state: a field the new model drops
     (provider on a single-provider engine, effort on a non-reasoning
     model, fast on a model with no tier) writes NULL so the old pick
     can't linger on the conversation row or the footer (#92 AC-4). */
  const patch: ConversationPickPatch = {
    model: pick.model,
    provider: pick.provider ?? null,
    effort: pick.effort ?? null,
    fast: pick.fast ?? null,
  };
  if (binding && conn) {
    if (binding.runningTurnId) {
      /* Hold the pick while a turn runs: a mid-turn setModel would either
         mutate the running session (a live fast flip is checked against
         the OLD model, and its provider request overrides can ride onto
         the new one) or land in an engine deferred stash the next prompt
         races. Held here and applied on the idle session before the next
         prompt, the engine only ever sees a plain setModel — no deferral,
         no stash (#92 AC-4). Latest pick wins; a failed apply restores
         the row to what the session actually runs. */
      const conv = this.conversationFromAtom(conversationId);
      binding.heldPickPrev ??= {
        model: conv?.model ?? null,
        provider: conv?.provider ?? null,
        effort: conv?.effort ?? null,
        fast: conv?.fast ?? null,
      };
      binding.heldPick = pick;
    } else {
      /* A fresh pick on an idle session supersedes any pick still held
         from the turn that just ended — drop it so the queue-serialized
         apply can't land an older pick after this one. */
      binding.heldPick = undefined;
      binding.heldPickPrev = undefined;
      try {
        Object.assign(patch, await this.setSessionModel(binding, pick));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.opts.log.warn("session.setModel failed", {
          conversationId,
          error: detail,
        });
        await this.postSystem(
          binding,
          `Couldn't switch to ${pick.model}: ${detail}`,
        );
        return;
      }
    }
  }
  await this.updateConversation(conversationId, patch).catch((error) =>
    this.opts.log.warn("conversation model update failed", {
      conversationId,
      error: String(error),
    }),
  );
}

/**
 * `session.setModel` on an idle session, returning the corrections the
 * ack implies for the conversation row: the engine's canonical model id,
 * any field it rewrites, and `fast: null` + a short note when fast was
 * requested but the ack doesn't carry it (the pick runs without it).
 */
export async function setSessionModel(
  this: HarnessCtx,
  binding: SessionBinding,
  pick: ModelPick,
): Promise<ConversationPickPatch> {
  const conn = this.engine;
  if (!conn) throw new Error("engine not connected");
  const ack = await conn.request<{
    model: string;
    provider?: string;
    effort?: string;
    fast?: boolean;
    deferred?: boolean;
  }>("session.setModel", {
    sessionId: binding.sessionId,
    ...pick,
  });
  const patch: ConversationPickPatch = { model: ack.model };
  if (ack.provider !== undefined) patch.provider = ack.provider;
  if (ack.effort !== undefined) patch.effort = ack.effort;
  if (ack.fast !== undefined) {
    patch.fast = ack.fast;
  } else if (pick.fast !== undefined) {
    /* Fast was requested but the ack omits it — record the refusal so the
       picker doesn't show ⚡ on a turn that ran without it. */
    patch.fast = null;
    await this.postSystem(
      binding,
      `⚡ Fast isn't available for ${ack.model} — the pick runs without it.`,
      /* Unique key: a repeat refusal on the same model must still post —
         the picker showing ⚡ on a turn that ran without it is the bug
         the note exists for (#92 review). */
      `sys:${binding.conversationId}:pick-fast:${ack.model}:${Date.now()}`,
    );
  }
  return patch;
}

/**
 * A pick made while a turn ran, applied to the now-idle session before
 * the next prompt goes out. The intent already sits on the conversation
 * row; a failed apply restores the previous pick so the dead model can't
 * linger or be retried on restart, and `turn.started` keeps stamping what
 * the session actually ran. Serialized with `onModelRequested` through
 * `modelPickQueue` — a newer pick always lands after the held one.
 */
export function applyHeldPick(
  this: HarnessCtx,
  binding: SessionBinding,
): Promise<void> {
  const conversationId = binding.conversationId;
  const prev = this.modelPickQueue.get(conversationId) ?? Promise.resolve();
  const next = prev.then(() => this.doApplyHeldPick(binding));
  this.modelPickQueue.set(
    conversationId,
    next.catch(() => {}),
  );
  return next;
}

/**
 * Reattach after a harness restart: a pick written while the harness was
 * down sits only on the row — the session snapshot still shows the old
 * model while the UI shows the new one. When they differ, hold the row's
 * pick (prev = what the session actually runs) so it applies before the
 * next prompt; a failed apply restores the snapshot's values (#92).
 */
export function rebuildHeldPick(
  this: HarnessCtx,
  binding: SessionBinding,
  conv: Conversation,
  snap: EventsSinceResult["snapshot"],
) {
  if (!conv.model) return;
  const rowPick: ModelPick = { model: conv.model };
  if (conv.provider) rowPick.provider = conv.provider;
  if (conv.effort) rowPick.effort = conv.effort;
  if (conv.fast !== undefined) rowPick.fast = conv.fast;
  if (
    snap.model === rowPick.model &&
    snap.provider === rowPick.provider &&
    snap.effort === rowPick.effort &&
    snap.fast === rowPick.fast
  )
    return;
  binding.heldPickPrev = {
    model: snap.model ?? null,
    provider: snap.provider ?? null,
    effort: snap.effort ?? null,
    fast: snap.fast ?? null,
  };
  binding.heldPick = rowPick;
}

export async function doApplyHeldPick(
  this: HarnessCtx,
  binding: SessionBinding,
) {
  const pick = binding.heldPick;
  if (!pick) return;
  const prev = binding.heldPickPrev;
  binding.heldPick = undefined;
  binding.heldPickPrev = undefined;
  if (!this.engine) return; // intent stays on the row; session.start applies it
  try {
    const correction = await this.setSessionModel(binding, pick);
    await this.updateConversation(binding.conversationId, correction).catch(
      () => {},
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    this.opts.log.warn("held session.setModel failed", {
      conversationId: binding.conversationId,
      error: detail,
    });
    if (prev) {
      await this.updateConversation(binding.conversationId, prev).catch(
        () => {},
      );
    }
    await this.postSystem(
      binding,
      `Couldn't switch to ${pick.model}: ${detail}`,
      // Unique key: every failed apply surfaces, not just the first (#92).
      `sys:${binding.conversationId}:pick-failed:${pick.model}:${Date.now()}`,
    );
  }
}
