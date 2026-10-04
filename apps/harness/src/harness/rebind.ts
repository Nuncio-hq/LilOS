import type { HarnessCtx, SessionBinding } from "./ctx";

/**
 * Conversation rebind: one in-flight rebind per conversation, the
 * `session.start` + queue/steer transplant, and the engine-side
 * title/archive mirror (was the `rebindConversation`/`mirrorMeta` run of
 * `../harness.ts`).
 *
 * Moved verbatim out of `../harness.ts` (#441) — bodies byte-identical except each signature gained
 * `export function` + a `this: HarnessCtx` first parameter — `this` is
 * still the Harness: these functions sit on `Harness.prototype` via the
 * `Object.assign` at the bottom of `../harness.ts`.
 */

/** One rebind at a time per conversation — resync and prompt-failure paths race here. */
export function rebindConversation(
  this: HarnessCtx,
  binding: SessionBinding,
): Promise<void> {
  const pending = this.rebinds.get(binding.conversationId);
  if (pending) return pending;
  const p = this.doRebindConversation(binding).finally(() =>
    this.rebinds.delete(binding.conversationId),
  );
  this.rebinds.set(binding.conversationId, p);
  return p;
}

export async function doRebindConversation(
  this: HarnessCtx,
  binding: SessionBinding,
) {
  const conv = this.conversationFromAtom(binding.conversationId);
  const employee = await this.resolveEmployee(conv);
  const conn = this.engine;
  if (!conn) return;
  const agent = await this.ensureAgent(conn, employee);
  const surface = this.createSurfaces(binding, conv, employee);
  const started = await conn.request<{
    sessionId: string;
    ref?: string;
    engineSessionId?: string;
  }>(
    "session.start",
    this.sessionParams(employee, agent, conv, surface?.mcpServer),
  );
  this.aliasSurfaces(surface?.session, started.engineSessionId);
  // Session lost on the engine (fresh engine/orphan grace expired): a turn
  // that was running ended silently — surface interrupted + Retry (AC-4).
  if (binding.runningTurnId) {
    await this.markTurnInterrupted(binding, binding.runningTurnId);
  }
  this.unbind(binding);
  const rebound: SessionBinding = {
    ...binding,
    sessionId: started.sessionId,
    ref: started.ref ?? started.sessionId,
    engineSessionId: started.engineSessionId,
    gatewaySession: surface?.session,
    lastSeq: 0,
    runningTurnId: undefined,
    textByTurn: new Map(),
    pickByTurn: new Map(),
    /* A held pick already sits on the conversation row — the new session
       starts on it via `sessionParams`; nothing left to apply. */
    heldPick: undefined,
    heldPickPrev: undefined,
    promptGates: new Set(),
    nowStep: undefined,
    nowWaits: new Map(),
    nowAt: 0,
    /* The old session's in-flight sends die with it — the rebound queue
       drains through sendPrompt, which re-arms its own entry. */
    inflightPrompts: new Set(),
    /* A dead session's stop mustn't park the live one, and its reconcile
       timer dies with it (#315). */
    stopRequested: false,
    stopParked: false,
    steerReconcileTimer: undefined,
    /* #346: the new session is live now — fresh clock, no suspended
       mark, and no subagents of the dead session survive it. */
    lastActivity: Date.now(),
    openSubagents: new Set(),
    suspended: false,
  };
  if (binding.steerReconcileTimer) clearTimeout(binding.steerReconcileTimer);
  this.bindings.set(binding.conversationId, rebound);
  this.conversationBySession.set(started.sessionId, binding.conversationId);
  // Idle, not active: a rebind with an empty queue has nothing running —
  // "active" would leave the conversation spinning forever. Requeued
  // messages flip it back to active via their own turn.started.
  await this.updateConversation(binding.conversationId, {
    engineRef: started.sessionId,
    state: "idle",
  });
  /* The old session is gone: an accepted-but-unlanded steer can never
     land on the rebound session — park it in the not-sent tray
     (#315 AC-5/AC-6). Same for the queue when a Stop had armed the
     park: nothing waiting auto-runs after it. */
  for (const pending of binding.steerPending.splice(0)) {
    binding.consumed.delete(pending.messageId);
    this.relayWrite(`drop steer ${pending.messageId}`, () =>
      this.opts.relay.request("messages.drop", {
        messageId: pending.messageId,
      }),
    );
  }
  const queued = binding.queue.splice(0);
  if (binding.stopRequested) {
    binding.stopRequested = false;
    /* #402: the queue this Stop dropped was everything a pre-bind parked
       interrupt could still wait on — the park is moot. */
    this.pendingInterrupts.delete(binding.conversationId);
    /* #403: the stamp splits "waiting when Stop landed" (park) from
       "sent after" (re-enters on the rebound session) — a send above
       `afterSeq`, or a re-Sent row, keeps its place instead of landing
       in the not-sent tray. */
    const stopSeq = this.stopSeqs.get(binding.conversationId);
    const owns = (id: string, seq: number) =>
      (stopSeq === undefined || seq <= stopSeq) &&
      !this.exemptFromCurrentStop(binding.conversationId, id);
    for (const message of queued) {
      if (!owns(message.id, message.seq)) {
        this.enqueueOrPrompt(rebound, message);
        continue;
      }
      binding.consumed.delete(message.id);
      this.relayWrite(`drop queued ${message.id}`, () =>
        this.opts.relay.request("messages.drop", { messageId: message.id }),
      );
    }
  } else {
    for (const message of queued) this.enqueueOrPrompt(rebound, message);
  }
  this.mirrorMeta(rebound, conv);
}

/**
 * Best-effort mirror of the app's title/archive onto the engine session
 * (capability `session_meta`, #28 AC-3). Engines without it keep working —
 * the relay record is the source of truth either way.
 */
export function mirrorMeta(
  this: HarnessCtx,
  binding: SessionBinding,
  conv:
    | { title: string; archived: boolean; titleSource?: "auto" | "user" }
    | undefined,
): void {
  if (!conv) return;
  const seen = this.metaSeen.get(binding.conversationId);
  this.metaSeen.set(binding.conversationId, {
    title: conv.title,
    archived: conv.archived,
    titleSource: conv.titleSource,
  });
  const conn = this.engine;
  if (!conn || !this.hasCapability("session_meta")) return;
  /* Only USER-chosen titles mirror onto the engine (#137): mirroring an
     engine-written title back via session.setTitle would mark it
     user-provenance on the engine side (Hermes `title_source=user`) and
     permanently block the derived → llm upgrade. */
  const titleIsUserChosen =
    conv.titleSource === undefined || conv.titleSource === "user";
  if (conv.title && titleIsUserChosen && (!seen || seen.title !== conv.title)) {
    void conn
      .request("session.setTitle", {
        sessionId: binding.sessionId,
        title: conv.title,
      })
      .catch((error) =>
        this.opts.log.warn("session.setTitle failed", {
          error: String(error),
        }),
      );
  }
  if (!seen || seen.archived !== conv.archived) {
    void conn
      .request("session.setHidden", {
        sessionId: binding.sessionId,
        hidden: conv.archived,
      })
      .catch((error) =>
        this.opts.log.warn("session.setHidden failed", {
          error: String(error),
        }),
      );
  }
}
