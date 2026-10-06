import type { Conversation, ConversationLife } from "@lilos/contracts/app";
import type { EventsSinceResult } from "@lilos/contracts/engine";
import { expandPath } from "@lilos/host";
import { engineErrorCode, SESSION_NOT_FOUND } from "../engine/client";
import type { ReaperCandidate } from "../reaper";
import type { HarnessCtx, SessionBinding } from "./ctx";

/**
 * Session binding: create on first send, the #346 idle reaper's
 * candidacy checks, and the parked-interrupt orphan guard (was the
 * `#346 idle reaper` section of `../harness.ts`).
 *
 * Moved verbatim out of `../harness.ts` (#441) — bodies byte-identical except each signature gained
 * `export function` + a `this: HarnessCtx` first parameter — `this` is
 * still the Harness: these functions sit on `Harness.prototype` via the
 * `Object.assign` at the bottom of `../harness.ts`.
 */

/**
 * Can a send still produce a turn on this conversation? Every tracked
 * resting place of a not-yet-turned send counts: bind or rebind in
 * flight, a `deliver` between its claim and `enqueueOrPrompt`, the
 * held-for-engine `early` queue, the binding's wait queue, steers
 * pending a pump, a prompt mid-dispatch, and a send claimed into
 * `consumed` whose `turn.started` never landed. A bare binding or a
 * running turn is NOT pending — neither produces the next turn alone.
 */
/** #346 AC-4: write the conversation's `life` once per change — the
    relay mirrors it to every client for the ring. */
export function writeLife(
  this: HarnessCtx,
  conversationId: string,
  life: ConversationLife,
) {
  const conv = this.conversationFromAtom(conversationId);
  if (conv?.life === life) return;
  this.updateConversation(conversationId, { life }).catch((error) =>
    this.opts.log.warn("life write failed", {
      conversationId,
      error: String(error),
    }),
  );
}

/** Sessions the reaper may suspend: live, quiet, and with nothing that
    could still produce a turn, an open ask, or a running subagent. */
export function reaperCandidates(this: HarnessCtx): ReaperCandidate[] {
  const out: ReaperCandidate[] = [];
  for (const binding of this.bindings.values()) {
    if (!binding.sessionId || binding.suspended) continue;
    if (binding.runningTurnId) continue; // a turn runs
    if (binding.openSubagents.size) continue; // a subagent runs
    if (this.sessionHasOpenAsk(binding.sessionId)) continue; // an ask is open
    if (this.sendCanProduceTurn(binding.conversationId)) continue;
    out.push({
      conversationId: binding.conversationId,
      sessionId: binding.sessionId,
      lastActivity: binding.lastActivity,
    });
  }
  return out;
}

/** An engine ask (approval/question) still open on this session — the
    `requestByAsk` map keys are relay ask ids, its rows hold the session. */
export function sessionHasOpenAsk(
  this: HarnessCtx,
  sessionId: string,
): boolean {
  for (const rec of this.requestByAsk.values()) {
    if (rec.sessionId === sessionId) return true;
  }
  return false;
}

export async function suspendBinding(
  this: HarnessCtx,
  sessionId: string,
): Promise<void> {
  const conn = this.engine;
  if (!conn) throw new Error("engine not attached");
  await conn.request("session.suspend", { sessionId });
}

export function onReaperSuspended(
  this: HarnessCtx,
  conversationId: string,
  sessionId: string,
) {
  const binding = this.bindings.get(conversationId);
  if (binding?.sessionId === sessionId) binding.suspended = true;
  /* The suspend's `session.state closed` event usually lands too — this
     write covers engines that don't echo it (and races where the event
     arrived first are deduped by writeLife). */
  this.writeLife(conversationId, "closed");
}

export function sendCanProduceTurn(
  this: HarnessCtx,
  conversationId: string,
): boolean {
  if (this.binds.has(conversationId)) return true;
  if (this.rebinds.has(conversationId)) return true;
  if ((this.inFlightDeliveries.get(conversationId) ?? 0) > 0) return true;
  if ((this.early.get(conversationId)?.length ?? 0) > 0) return true;
  const binding = this.bindings.get(conversationId);
  if (!binding) return false;
  if (binding.queue.length > 0) return true;
  if (binding.steerPending.length > 0) return true;
  if (binding.promptGates.size > 0) return true;
  /* A consumed send whose ref never became a `turnSource` value is
     claimed by the engine but has no turn yet — the post-dispatch,
     pre-`turn.started` stretch. (Size comparison alone lies: a removed
     send's ref lingers in turnSource after `consumed` drops it.) */
  const turned = new Set(binding.turnSource.values());
  for (const id of binding.consumed) if (!turned.has(id)) return true;
  return false;
}

/**
 * #402: a parked Stop lives only as long as the send it waits on — once
 * nothing can still produce that send's first turn, keeping it would
 * fire the interrupt on a later unrelated turn instead of the one the
 * user meant.
 */
export function dropParkedInterruptIfOrphaned(
  this: HarnessCtx,
  conversationId: string | null | undefined,
) {
  if (!conversationId || !this.pendingInterrupts.has(conversationId)) return;
  if (this.sendCanProduceTurn(conversationId)) return;
  this.pendingInterrupts.delete(conversationId);
}

export async function bindingFor(
  this: HarnessCtx,
  conv: Conversation,
  channelId: string,
): Promise<SessionBinding | undefined> {
  const existing = this.bindings.get(conv.id);
  if (existing) return existing;
  const inFlight = this.binds.get(conv.id);
  if (inFlight) return inFlight;
  const pending = this.bindConversation(conv, channelId).finally(() => {
    this.binds.delete(conv.id);
    /* A parked Stop is moot when the bind produced nothing to stop — drop
       it instead of interrupting whatever turn the next bind creates. */
    if (!this.bindings.has(conv.id)) this.pendingInterrupts.delete(conv.id);
  });
  this.binds.set(conv.id, pending);
  return pending;
}

export async function bindConversation(
  this: HarnessCtx,
  conv: Conversation,
  channelId: string,
): Promise<SessionBinding | undefined> {
  const existing = this.bindings.get(conv.id);
  if (existing) return existing;
  const conn = this.engine;
  if (!conn) return undefined;
  /* #459: named e2e probe — park the whole bind so "surface session
     created" lands ~`bindDelayMs` after the send that triggered it, the
     same window the ~910ms prod bind opened. Deliveries waiting on
     `binds` must keep queuing/removable through the hold. */
  if (this.opts.bindDelayMs)
    await new Promise((r) => setTimeout(r, this.opts.bindDelayMs));

  // Reattach path: harness restarted while the engine kept the session
  // (orphan grace, #22) — the stored engineRef still resolves on the engine.
  if (conv.engineRef) {
    try {
      const replay = await conn.request<EventsSinceResult>("events.since", {
        sessionId: conv.engineRef,
        after: 0,
      });
      const binding: SessionBinding = {
        conversationId: conv.id,
        channelId,
        sessionId: conv.engineRef,
        ref: conv.engineRef,
        cwd: expandPath(conv.cwd ?? this.opts.workdir, this.home),
        hasFolder: Boolean(conv.cwd),
        access: conv.access,
        lastSeq: 0,
        queue: [],
        promptGates: new Set(),
        inflightPrompts: new Set(),
        textByTurn: new Map(),
        pickByTurn: new Map(),
        consumed: new Set(),
        turnSource: new Map(),
        steerPending: [],
        steerLanded: [],
        stopRequested: false,
        nowWaits: new Map(),
        nowAt: 0,
        lastActivity: Date.now(),
        openSubagents: new Set(),
        suspended: false,
      };
      this.bindings.set(conv.id, binding);
      this.conversationBySession.set(conv.engineRef, conv.id);
      this.applyReplay(binding, replay);
      /* #550: replayed `turn.steered` events land in `steerLanded`, but
         the steer RPCs they would claim already resolved on the old conn
         — drop the history so a later same-text steer can't inherit it. */
      binding.steerLanded.length = 0;
      this.rebuildHeldPick(binding, conv, replay.snapshot);
      /* Reattach carries no `engineSessionId` — the stored key was never
         stored on the conversation. Create the gateway session anyway;
         the alias lands on the next `session.ref.changed` (#339). */
      const employee = await this.resolveEmployee(conv);
      binding.employeeId = employee?.id;
      const surface = this.createSurfaces(binding, conv, employee);
      binding.gatewaySession = surface?.session;
      return binding;
    } catch (error) {
      if (engineErrorCode(error) !== SESSION_NOT_FOUND) throw error;
    }
  }

  /* A workstream open (#156 mode "new") materializes its worktree before
     the first `session.start`; a failure leaves the thread idle with a
     system note rather than starting the session in the wrong folder.
     The held message re-delivers on the next register (pending list). */
  if (conv.workspace?.mode === "new") {
    try {
      await this.ensureWorktree(conv);
    } catch (error) {
      this.opts.log.error("worktree creation failed", {
        conversationId: conv.id,
        error: String(error),
      });
      await this.postSystem(
        { channelId, conversationId: conv.id },
        `Couldn't create worktree ${conv.workspace.branch} — ${error instanceof Error ? error.message : String(error)}`,
        `sys:${conv.id}:worktree`,
      );
      return undefined;
    }
  }

  const employee = await this.resolveEmployee(conv);
  const agent = await this.ensureAgent(conn, employee);
  const binding: SessionBinding = {
    conversationId: conv.id,
    channelId,
    sessionId: "",
    ref: "",
    cwd: expandPath(conv.cwd ?? this.opts.workdir, this.home),
    hasFolder: Boolean(conv?.cwd),
    access: conv?.access ?? "ask",
    lastSeq: 0,
    queue: [],
    promptGates: new Set(),
    inflightPrompts: new Set(),
    textByTurn: new Map(),
    pickByTurn: new Map(),
    consumed: new Set(),
    turnSource: new Map(),
    steerPending: [],
    steerLanded: [],
    stopRequested: false,
    nowWaits: new Map(),
    nowAt: 0,
    lastActivity: Date.now(),
    openSubagents: new Set(),
    suspended: false,
  };
  binding.employeeId = employee?.id;
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
  binding.sessionId = started.sessionId;
  binding.ref = started.ref ?? started.sessionId;
  binding.engineSessionId = started.engineSessionId;
  binding.gatewaySession = surface?.session;
  this.bindings.set(conv.id, binding);
  this.conversationBySession.set(started.sessionId, conv.id);
  await this.updateConversation(conv.id, {
    engineRef: started.sessionId,
    state: "active",
  });
  return binding;
}
