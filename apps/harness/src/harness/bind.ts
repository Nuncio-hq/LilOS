import type { Conversation, ConversationLife } from "@lilos/contracts/app";
import type { EventsSinceResult } from "@lilos/contracts/engine";
import { expandPath, HostError } from "@lilos/host";
import {
  engineErrorCode,
  RESUME_AWARE_TIMEOUT_MS,
  SESSION_NOT_FOUND,
} from "../engine/client";
import {
  normalizeRuntime,
  parseSessionRef,
  qualifySessionRef,
} from "../engine/runtimes";
import type { ReaperCandidate } from "../reaper";
import { employeeHoldsCeo } from "./ceo-session";
import type { HarnessCtx, SessionBinding } from "./ctx";
import { goneBranchNote } from "./worktree-cleanup";

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
    if (this.sessionHasOpenAsk(binding.runtime, binding.sessionId)) continue; // an ask is open
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
    `requestByAsk` map keys are relay ask ids, its rows hold the qualified
    session ref (D-#761). */
export function sessionHasOpenAsk(
  this: HarnessCtx,
  runtime: string,
  sessionId: string,
): boolean {
  const key = this.sessionKey(runtime, sessionId);
  for (const rec of this.requestByAsk.values()) {
    if (rec.sessionId === key) return true;
  }
  return false;
}

export async function suspendBinding(
  this: HarnessCtx,
  sessionId: string,
): Promise<void> {
  /* D-#761: the session id is engine-local — find the owning binding so
     the suspend lands on the right engine. */
  const binding = [...this.bindings.values()].find(
    (b) => b.sessionId === sessionId,
  );
  const conn = binding ? this.connFor(binding) : this.connForRuntime("hermes");
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
  const inner = this.bindConversation(conv, channelId);
  /* D-#866 r5: the drop surface reads the real bind reason instead of
     "several attempts". Detached observer — it must NOT extend the
     awaited `pending` chain: extra settle hops once let a `!binding`
     park land after attachEngine's `early` sweep, orphaning the send. */
  void inner.then(
    () => {
      this.lastBindError.delete(conv.id);
    },
    (error: unknown) => {
      this.lastBindError.set(conv.id, String(error));
    },
  );
  const pending = inner.finally(() => {
    this.binds.delete(conv.id);
    /* A parked Stop is moot when the bind produced nothing to stop — drop
       it instead of interrupting whatever turn the next bind creates. */
    if (!this.bindings.has(conv.id)) this.pendingInterrupts.delete(conv.id);
  });
  this.binds.set(conv.id, pending);
  return pending;
}

/** D-#25: a thread is one engine session with one agent — in a project or a
    plain chat, never a DM (the employee's channel is the relay's internal
    routing scope only). The harness alone writes
    `engineRef` (the relay refuses it from any other peer) — reattach the
    stored ref, else `session.start` a new one and stamp it. */
export async function bindConversation(
  this: HarnessCtx,
  conv: Conversation,
  channelId: string,
): Promise<SessionBinding | undefined> {
  const existing = this.bindings.get(conv.id);
  if (existing) return existing;
  /* D-#761: the conversation binds to ITS agent's runtime — a stored
     engineRef's qualifier wins for reattach (the session demonstrably
     lives there), else the employee's `runtime` picks the engine and
     the registry starts it lazily on first demand. Absent = "hermes",
     so pre-#761 threads bind exactly where they did. */
  const storedRef = conv.engineRef
    ? parseSessionRef(conv.engineRef)
    : undefined;
  const bindingEmployee = storedRef
    ? undefined
    : await this.resolveEmployee(conv);
  const runtime =
    storedRef?.runtime ?? normalizeRuntime(bindingEmployee?.runtime);
  /* D-#881: the worktree must exist before ANY session path — a `new`
     workstream's first `session.start`, AND a reattach whose thread's
     copy the settled cleanup took while it slept (un-settle or a fresh
     message re-materializes it from the branch first). A branch the
     cleanup deleted post-merge reads as "gone" — the thread hears that
     instead of a bare git error. Either failure leaves the thread idle
     with a system note; the held message re-delivers on next register. */
  if (conv.workspace) {
    try {
      await this.ensureWorktree(conv);
    } catch (error) {
      const gone =
        error instanceof HostError &&
        (error.data as { reason?: string } | undefined)?.reason === "gone";
      this.opts.log.error("worktree materialize failed", {
        conversationId: conv.id,
        error: String(error),
      });
      /* The dedupe key carries the settle stamp — a later cycle's note
         is its own incident; the un-settle restore posts under the same
         key so a re-bind never doubles the note. */
      await this.postSystem(
        { channelId, conversationId: conv.id },
        gone
          ? await goneBranchNote(conv.workspace.repoPath, conv.workspace.branch)
          : `Couldn't create worktree ${conv.workspace.branch} — ${error instanceof Error ? error.message : String(error)}`,
        `sys:${conv.id}:worktree:${this.worktreeCleaned.get(conv.id) ?? 0}`,
      );
      return undefined;
    }
  }

  const conn = await this.ensureRuntime(runtime);
  if (!conn) return undefined;
  /* #459: named e2e probe — park the whole bind so "surface session
     created" lands ~`bindDelayMs` after the send that triggered it, the
     same window the ~910ms prod bind opened. Deliveries waiting on
     `binds` must keep queuing/removable through the hold. */
  if (this.opts.bindDelayMs)
    await new Promise((r) => setTimeout(r, this.opts.bindDelayMs));

  // Reattach path: harness restarted while the engine kept the session
  // (orphan grace, #22) — the stored engineRef still resolves on the engine.
  if (conv.engineRef && storedRef) {
    try {
      /* #834: reattach rides the adapter's lazy resume too — the resumed
         session rebuild can outlast the default call deadline. D-#761:
         the engine sees its own (stripped) id, never the qualifier. */
      const replay = await conn.request<EventsSinceResult>(
        "events.since",
        {
          sessionId: storedRef.sessionId,
          after: 0,
        },
        RESUME_AWARE_TIMEOUT_MS,
      );
      const binding: SessionBinding = {
        conversationId: conv.id,
        channelId,
        runtime,
        sessionId: storedRef.sessionId,
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
        runningJobs: new Set(),
        suspended: false,
      };
      /* The `conv` snapshot predates the `events.since` await — mirror
         the current row so a flip during it can't land stale. */
      binding.access =
        this.conversationFromAtom(conv.id)?.access ?? binding.access;
      this.bindings.set(conv.id, binding);
      this.conversationBySession.set(
        this.sessionKey(runtime, storedRef.sessionId),
        conv.id,
      );
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
      const ceoAtStart = await employeeHoldsCeo(
        this.opts.relay,
        employee?.id,
        this.opts.log,
      );
      const surface = this.createSurfaces(binding, conv, employee, ceoAtStart);
      binding.gatewaySession = surface?.session;
      return binding;
    } catch (error) {
      if (engineErrorCode(error) !== SESSION_NOT_FOUND) throw error;
    }
  }

  const employee = bindingEmployee ?? (await this.resolveEmployee(conv));
  const agent = await this.ensureAgent(conn, employee);
  /* D-#817: the profile's plugin has to be the shipped tree before
     session.start — Hermes imports it for this thread. UI hire and
     team_hire call agents.create (no clone_from) before employees.create,
     so the home can already hold a stale same-version copy; ensureAgent
     may also have just created the home. A reconcile already in flight
     queues one follow-up, and this wait includes that pass. */
  if (this.opts.connect) await this.opts.connect.reconcile();
  const binding: SessionBinding = {
    conversationId: conv.id,
    channelId,
    runtime,
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
    runningJobs: new Set(),
    suspended: false,
  };
  binding.employeeId = employee?.id;
  const ceoAtStart = await employeeHoldsCeo(
    this.opts.relay,
    employee?.id,
    this.opts.log,
  );
  const surface = this.createSurfaces(binding, conv, employee, ceoAtStart);
  const started = await conn.request<{
    sessionId: string;
    ref?: string;
    engineSessionId?: string;
    notes?: string[];
  }>(
    "session.start",
    await this.sessionParams(employee, agent, conv, surface?.mcpServer),
    /* D-#866: an ACP agent's first session legitimately outlives the 15s
       default — its spawned child pays a one-time security-context init
       under a fresh app ancestry (~14s observed installed). The engine's
       own create bound (45s) errors a true wedge before this fires. */
    60_000,
  );
  this.aliasSurfaces(surface?.session, started.engineSessionId);
  binding.sessionId = started.sessionId;
  /* D-#761: the durable ref is runtime-qualified for non-default engines
     — two engines both owning "s-1" must not collide on engineRef or the
     feed's session key. The default runtime keeps the bare id so pre-#761
     rows, feed clients, and session-event payloads are unchanged. */
  binding.ref = qualifySessionRef(runtime, started.ref ?? started.sessionId);
  binding.engineSessionId = started.engineSessionId;
  binding.gatewaySession = surface?.session;
  /* r8: `access` was copied before a `session.start` that can run 60s —
     a pill flip in that window updates the conversation row but found
     no binding to mirror onto. Re-read the live row now so the stored
     binding can't carry a stale "full" into request.opened. */
  binding.access = this.conversationFromAtom(conv.id)?.access ?? binding.access;
  this.bindings.set(conv.id, binding);
  this.conversationBySession.set(
    this.sessionKey(runtime, started.sessionId),
    conv.id,
  );
  await this.updateConversation(conv.id, {
    engineRef: binding.ref,
    state: "active",
  });
  /* D-#846: picks the session couldn't take ride home in the result —
     posting them now (post-binding) shows the same system note a
     session.note event would, without the registration race. */
  for (const [i, text] of (started.notes ?? []).entries())
    this.postSystem(
      binding,
      text,
      `sys:${conv.id}:note:${started.sessionId}:start:${i}`,
    ).catch(() => {});
  return binding;
}
