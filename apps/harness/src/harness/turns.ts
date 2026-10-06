import type { Conversation, Employee } from "@lilos/contracts/app";
import type { EngineEvent, McpServer } from "@lilos/contracts/engine";
import type { HarnessCtx, SessionBinding } from "./ctx";
import { BACKEND_DOWN } from "./rpc";

/**
 * Turn completion: the answer post + dedupe, the Stop park
 * sweep, stranded-steer reconcile, unbind, and gateway surfaces minting
 * (was the `turn completion` section of `../harness.ts`).
 *
 * Moved verbatim out of `../harness.ts` (#441) — bodies byte-identical except each signature gained
 * `export function` + a `this: HarnessCtx` first parameter — `this` is
 * still the Harness: these functions sit on `Harness.prototype` via the
 * `Object.assign` at the bottom of `../harness.ts`.
 */

export async function finishTurn(
  this: HarnessCtx,
  binding: SessionBinding,
  event: Extract<EngineEvent, { type: "turn.completed" }>,
) {
  const { turnId, stopReason } = event.payload;
  const text = binding.textByTurn.get(turnId) ?? "";
  const pick = binding.pickByTurn.get(turnId);
  binding.textByTurn.delete(turnId);
  binding.pickByTurn.delete(turnId);
  binding.runningTurnId = undefined;
  this.opts.sleep.release();
  // #422: the turn ended — the header falls back to the role only.
  binding.nowStep = undefined;
  binding.nowWaits.clear();
  this.noteNow(binding);

  const employeeId = this.employeeIdFor(
    this.conversationFromAtom(binding.conversationId),
  );
  const hasAnswer = text.trim().length > 0 && !!employeeId;
  // The answer dedupes under the user message that prompted the turn
  // (turn.started.ref); re-prompts of the same message — a rebind redelivery
  // — hit the same key instead of posting a duplicate.
  const source = binding.turnSource.get(turnId) ?? turnId;
  if (hasAnswer) {
    this.relayWrite(`answer ${turnId}`, () =>
      this.opts.relay.request("messages.post", {
        channelId: binding.channelId,
        conversationId: binding.conversationId,
        authorKind: "employee",
        authorId: employeeId,
        text: text.trim(),
        ...(pick?.model ? { model: pick.model } : {}),
        ...(pick?.provider ? { provider: pick.provider } : {}),
        ...(pick?.effort ? { effort: pick.effort } : {}),
        ...(pick?.fast !== undefined ? { fast: pick.fast } : {}),
        dedupeKey: `answer:${binding.conversationId}:${source}`,
      }),
    );
  }
  // An errored turn must leave a trace even when text streamed before it —
  // in-view conversations never notify, so this is the only failure signal.
  if (event.payload.errorCode === BACKEND_DOWN) {
    /* #521: the turn died with the backend — same restart surface as the
       prompt's own rejection path; the shared dedupe key keeps it single. */
    await this.surfaceBackendDown(binding, source);
  } else if (event.payload.error) {
    await this.postSystem(
      binding,
      `Error: ${event.payload.error}`,
      `sys:${binding.conversationId}:${source}:error`,
    );
  } else if (!hasAnswer && stopReason === "cancelled") {
    await this.postSystem(
      binding,
      "Stopped.",
      `sys:${binding.conversationId}:${source}:stopped`,
    );
  } else if (!hasAnswer) {
    await this.postSystem(
      binding,
      "(the engine ended the turn silently)",
      `sys:${binding.conversationId}:${source}:silent`,
    );
  }
  this.updateConversation(binding.conversationId, {
    state: "idle",
    /* #419: the DM session card's failure — the turn model carries it
       too, but the row keeps it across a session rebind/reload. A
       backend-death turn was already stamped by surfaceBackendDown. */
    ...(event.payload.error && event.payload.errorCode !== BACKEND_DOWN
      ? {
          turnFailure: {
            kind: "model" as const,
            text: event.payload.error,
          },
        }
      : {}),
  }).catch(() => {});

  /* #315 AC-5: ■ Stop parks everything still waiting — queued sends and
     accepted-but-unlanded steers alike land in the not-sent tray
     (dropped), never the engine. The sweep rides the delivery chain
     (#377): every `deliver` already in flight when the turn ended is a
     pre-stop send and must park too — running ahead of it would let a
     sent-before-Stop message slip past the tray. Sends arriving after
     the sweep link see the flag cleared and prompt fresh. Parked ids
     join `dismissed` so a late `not_running` steer ack holding a stale
     (pre-drop) row can't re-prompt it; Send clears both. */
  if (binding.stopRequested) {
    void this.ordered(binding.conversationId, async () => {
      /* #487: the sweep runs deferred through `ordered` — a rebind in
         between must not leave `stopRequested`/`stopParked` set on the
         live binding while the flags clear on a replaced copy. */
      const live = this.liveBinding(binding);
      live.stopRequested = false;
      live.stopParked = true;
      /* #402: every send a pre-bind parked interrupt could still wait on
         just dropped to the tray — the park is moot. */
      this.pendingInterrupts.delete(live.conversationId);
      /* #403: the stamp splits "waiting when Stop landed" (park) from
         "sent after" (kept): a send above `afterSeq`, or a re-Sent row,
         stays queued for the drain below. */
      const stopSeq = this.stopSeqs.get(live.conversationId);
      const owns = (id: string, seq: number) =>
        (stopSeq === undefined || seq <= stopSeq) &&
        !this.exemptFromCurrentStop(live.conversationId, id);
      const keptSteers: SessionBinding["steerPending"] = [];
      for (const pending of live.steerPending.splice(0)) {
        if (!owns(pending.messageId, pending.seq)) {
          keptSteers.push(pending);
          continue;
        }
        live.consumed.delete(pending.messageId);
        this.dismissed.add(pending.messageId);
        this.relayWrite(`drop steer ${pending.messageId}`, () =>
          this.opts.relay.request("messages.drop", {
            messageId: pending.messageId,
          }),
        );
      }
      live.steerPending.push(...keptSteers);
      for (const queued of live.queue.splice(0)) {
        if (!owns(queued.id, queued.seq)) {
          live.queue.push(queued);
          continue;
        }
        live.consumed.delete(queued.id);
        this.dismissed.add(queued.id);
        this.relayWrite(`drop queued ${queued.id}`, () =>
          this.opts.relay.request("messages.drop", { messageId: queued.id }),
        );
      }
      /* Sends that postdate the Stop drain like a normal turn end —
         only now that the sweep ran inside this conversation's delivery
         order. */
      this.drainQueue(live);
    });
    return;
  }
  /* An accepted steer that neither landed nor pumped as this turn's
     replacement is stranded — give it a grace window, then drop it. */
  this.scheduleSteerReconcile(binding);
  this.drainQueue(binding);
}

/* #315: an accepted steer (`session.steer` → `steered`) that neither
   landed (`turn.steered`) nor pumped as the next turn's `ref` was
   consumed but will never run — the user sees it "waiting" forever.
   After a short grace for late events, park it in the not-sent tray
   (`messages.drop`) so the user can Send it again. */
export function scheduleSteerReconcile(
  this: HarnessCtx,
  binding: SessionBinding,
) {
  if (binding.steerReconcileTimer) clearTimeout(binding.steerReconcileTimer);
  binding.steerReconcileTimer = setTimeout(() => {
    binding.steerReconcileTimer = undefined;
    /* A new turn owns the pend list again — its `turn.steered` / `ref`
       claims pair what the engine actually kept. */
    if (binding.runningTurnId || !binding.steerPending.length) return;
    for (const pending of binding.steerPending.splice(0)) {
      binding.consumed.delete(pending.messageId);
      this.relayWrite(`drop stranded steer ${pending.messageId}`, () =>
        this.opts.relay.request("messages.drop", {
          messageId: pending.messageId,
        }),
      );
    }
  }, 2000);
}

export function unbind(this: HarnessCtx, binding: SessionBinding) {
  // #422: this session's line stops counting toward the employee's now.
  binding.nowStep = undefined;
  binding.nowWaits.clear();
  this.noteNow(binding);
  if (binding.gatewaySession) {
    const gw = binding.gatewaySession;
    binding.gatewaySession = undefined;
    void this.opts.surfaces?.destroy(gw).catch(() => {});
  }
  this.conversationBySession.delete(binding.sessionId);
  this.bindings.delete(binding.conversationId);
}

/**
 * Mint the gateway session backing a binding's surfaces (#337/#339):
 * the scope declares employee/channel/conversation up front; the
 * engine's own session id binds as an alias once `session.start`
 * returns it. `attach === "mcp"` also yields the stdio server spec the
 * session must carry; "plugin" engines reach the same surfaces
 * in-process (Hermes' lilos plugin resolves the alias instead).
 */
export function createSurfaces(
  this: HarnessCtx,
  binding: SessionBinding,
  conv: Conversation | undefined,
  employee: Employee | undefined,
): { session: string; mcpServer?: McpServer } | undefined {
  const surfaces = this.opts.surfaces;
  if (!surfaces) return undefined;
  if (binding.gatewaySession) {
    void surfaces.destroy(binding.gatewaySession).catch(() => {});
    binding.gatewaySession = undefined;
  }
  const employeeId = this.employeeIdFor(conv);
  try {
    const handle = surfaces.create({
      cwd: binding.cwd,
      ...(employeeId && employee
        ? {
            binding: {
              employeeId,
              channelId: binding.channelId,
              conversationId: binding.conversationId,
            },
          }
        : {}),
    });
    return {
      session: handle.session,
      ...(this.opts.surfacesAttach === "mcp"
        ? { mcpServer: handle.mcpServer }
        : {}),
    };
  } catch (error) {
    this.opts.log.warn("surfaces session create failed", {
      conversationId: binding.conversationId,
      error: String(error),
    });
    return undefined;
  }
}

/** Alias the engine's own session id onto the gateway session (#339). */
export function aliasSurfaces(
  this: HarnessCtx,
  session: string | undefined,
  engineSessionId: string | undefined,
): void {
  if (!session || !engineSessionId || !this.opts.surfaces) return;
  try {
    this.opts.surfaces.bindEngineSession(session, engineSessionId);
  } catch {
    /* Late rotation after the gateway session died — next ref retries. */
  }
}
