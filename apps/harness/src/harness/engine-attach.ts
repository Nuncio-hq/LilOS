import type { Employee } from "@lilos/contracts/app";
import type {
  AgentDescriptor,
  DescribeResult,
  EventsSinceResult,
} from "@lilos/contracts/engine";
import {
  type EngineConnection,
  engineErrorCode,
  SESSION_NOT_FOUND,
} from "../engine/client";
import type { HarnessCtx, SessionBinding } from "./ctx";

/**
 * Engine (re)attach: describe + first-run hire, per-binding
 * event replay, and the lost-turn surfaces a gap implies (was the
 * `describeAndHire`…`surfaceBackendDown` run of `../harness.ts`).
 *
 * Moved verbatim out of `../harness.ts` (#441) — bodies byte-identical except each signature gained
 * `export function` + a `this: HarnessCtx` first parameter — `this` is
 * still the Harness: these functions sit on `Harness.prototype` via the
 * `Object.assign` at the bottom of `../harness.ts`.
 */

/**
 * On (re)connect: cache `describe` (minus hidden capabilities) and hire the
 * `default` engine profile as the first employee when the roster is empty.
 */
export async function describeAndHire(
  this: HarnessCtx,
  conn: EngineConnection,
): Promise<void> {
  try {
    const d = await conn.request<DescribeResult>("describe", {});
    const hide = new Set(this.opts.hideCaps ?? []);
    this.describeResult = {
      ...d,
      capabilities: d.capabilities.filter((c) => !hide.has(c.id)),
    };
  } catch (error) {
    this.describeResult = undefined;
    this.opts.log.warn("engine describe failed", {
      error: String(error),
    });
  }
  if (this.hired) return;
  this.hired = true;
  try {
    // connect() is idempotent: no-op when already up, waits when the
    // engine attached before harness.start() finished the handshake.
    await this.opts.relay.connect();
    const { employees } = await this.opts.relay.request<{
      employees: Employee[];
    }>("employees.list", {});
    if (employees.length > 0) return;
    const { agents } = await conn.request<{ agents: AgentDescriptor[] }>(
      "agents.list",
      {},
    );
    const agent = agents.find((a) => a.id === "default") ?? agents[0];
    if (!agent) return;
    const created = await this.opts.relay.request<{ employee: Employee }>(
      "employees.create",
      {
        name: agent.name,
        role: agent.description ?? "",
        status: "online",
        profile: agent.id,
        // No `model` copy: the catalog entry is the engine's default, and a
        // pinned employee model would override operator-set engine model
        // flags (HERMES_MODEL / --model) on every session.
        ...(agent.soul ? { instructions: agent.soul } : {}),
      },
    );
    // The web hire path opens the DM channel up front so the employee's DM
    // never renders a perpetual skeleton (hireEmployee); the first-run
    // hire does the same (#193). `channels.openDm` is idempotent.
    await this.opts.relay.request("channels.openDm", {
      employeeId: created.employee.id,
    });
    this.opts.log.info("hired first employee", {
      employeeId: created.employee.id,
      agent: agent.id,
    });
  } catch (error) {
    this.opts.log.warn("first-run hire failed", { error: String(error) });
  }
}

export async function resyncBinding(
  this: HarnessCtx,
  binding: SessionBinding,
): Promise<void> {
  const conn = this.engine;
  if (!conn) return;
  try {
    const replay = await conn.request<EventsSinceResult>("events.since", {
      sessionId: binding.sessionId,
      after: binding.lastSeq,
    });
    this.applyReplay(binding, replay);
  } catch (error) {
    if (engineErrorCode(error) === SESSION_NOT_FOUND) {
      // Engine lost the session (fresh engine): rebind to a new one.
      await this.rebindConversation(binding);
      return;
    }
    throw error;
  }
}

export function applyReplay(
  this: HarnessCtx,
  binding: SessionBinding,
  replay: EventsSinceResult,
) {
  // The turn we were running before the gap; if replay neither shows it
  // still running nor carries its turn.completed, it died silently.
  const watchedTurnId = binding.runningTurnId;
  if (replay.truncated) {
    this.opts.log.warn("engine event log truncated; state is lossy", {
      sessionId: binding.sessionId,
    });
  }
  binding.lastSeq = Math.max(binding.lastSeq, replay.latestSeq);
  if (replay.snapshot.turn) {
    binding.runningTurnId = replay.snapshot.turn.turnId;
  }
  for (const open of replay.openRequests) {
    void this.openAsk(binding, open.turnId, open.requestId, open.request).catch(
      () => {},
    );
  }
  for (const event of replay.events) this.onEngineEvent(event);
  /* #137 AC-2: the snapshot title is the engine's persisted truth — it
     lands whatever the (possibly truncated) event log missed. The relay
     still refuses it over a user rename. */
  const snapshotTitle = replay.snapshot.title;
  if (
    snapshotTitle &&
    this.hasAutoTitle() &&
    this.metaSeen.get(binding.conversationId)?.titleSource !== "user"
  ) {
    this.updateConversation(binding.conversationId, {
      title: snapshotTitle,
    }).catch(() => {});
  }
  // AC-4: a turn that vanished across sleep/restart must end as
  // `interrupted` with Retry — never a spinner. Lost iff the replay shows
  // it neither still running nor terminated by a replayed turn.completed.
  // A truncated replay can't prove either (#431): the completed may be
  // cap-dropped, so the inference stays silent rather than stamping a
  // healthy turn interrupted.
  const finishedInReplay = replay.events.some(
    (e) => e.type === "turn.completed" && e.payload.turnId === watchedTurnId,
  );
  if (
    watchedTurnId &&
    !replay.truncated &&
    replay.snapshot.turn?.turnId !== watchedTurnId &&
    !finishedInReplay
  ) {
    void this.markTurnInterrupted(binding, watchedTurnId);
  }
}

/** End a turn that vanished across a gap — surface interrupted + Retry. */
export async function markTurnInterrupted(
  this: HarnessCtx,
  binding: SessionBinding,
  turnId: string,
): Promise<void> {
  // Only release the sleep hold/clear the slot when the lost turn still
  // owns it — a different adopted turn must keep its own hold.
  if (binding.runningTurnId === turnId) {
    binding.runningTurnId = undefined;
    binding.textByTurn.delete(turnId);
    this.opts.sleep.release();
    binding.nowStep = undefined;
    binding.nowWaits.clear();
    this.noteNow(binding);
    /* #419: the lost turn's event log orphans with this session (the
       rebind swaps engineRef), so the failure card can't ride the turn
       — stamp it on the conversation; the next turn.started clears it. */
    await this.updateConversation(binding.conversationId, {
      state: "idle",
      turnFailure: {
        kind: "sleep",
        text: "Interrupted — the Mac slept or the engine restarted.",
      },
    });
    /* The turn vanished mid-run — pending steers can't land anymore. */
    this.scheduleSteerReconcile(binding);
  }
  /* #419 AC-4: the note reports the interrupt; the Retry lives on the
     session card + turn, not in text nobody can click. */
  await this.postSystem(
    binding,
    "Turn interrupted — the Mac slept or the engine restarted.",
  );
}

/**
 * #521: a turn killed by the backend dying gets the same surface the
 * lost-turn path posts — interrupted note + the sleep failure card —
 * deduped on the prompting message: the prompt's own rejection AND the
 * turn's turn.completed can both carry -32006, and only one note posts.
 */
export async function surfaceBackendDown(
  this: HarnessCtx,
  binding: SessionBinding,
  sourceId: string,
): Promise<void> {
  await this.updateConversation(binding.conversationId, {
    state: "idle",
    turnFailure: {
      kind: "sleep",
      text: "Interrupted — the Mac slept or the engine restarted.",
    },
  });
  await this.postSystem(
    binding,
    "Turn interrupted — the Mac slept or the engine restarted.",
    `sys:${binding.conversationId}:${sourceId}:engine-restart`,
  );
}
