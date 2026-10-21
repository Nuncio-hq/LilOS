import {
  type EngineEvent,
  fallbackTurnNote,
  fmtTokens,
} from "@lilos/contracts/engine";
import type { HarnessCtx, SessionBinding } from "./ctx";
import {
  beginStuckTurn,
  noteStuckProgress,
  noteStuckTool,
  resumeStuckWatch,
  stuckOnNewMessage,
} from "./stuck";

/**
 * engine -> relay: the `onEngineEvent` switch — turn
 * lifecycle, asks, ref rotation, steers, session state (was the
 * `engine -> relay` section of `../harness.ts`).
 *
 * Moved verbatim out of `../harness.ts` (#441) — bodies byte-identical except each signature gained
 * `export function` + a `this: HarnessCtx` first parameter — `this` is
 * still the Harness: these functions sit on `Harness.prototype` via the
 * `Object.assign` at the bottom of `../harness.ts`.
 */

/**
 * Live-socket entry. `onEngineEvent` stays synchronous for replay.
 *
 * #814 / #572: SessionWatch seeds `running` from `state === "active"`
 * at boot, because a cold client has no broadcast history. The
 * completion used to be published first and the idle write
 * fire-and-forgotten after it, so a list in that gap — a loaded boot,
 * a second window — attached `events.since` for a turn that had
 * already ended. Commit idle before anyone can observe the event.
 * The caller's chain holds the next event so a new turn's `active`
 * write cannot land underneath this one. A failure to write still
 * publishes the event: losing the completion is worse than a stale row.
 */
export async function deliverLiveEngineEvent(
  this: HarnessCtx,
  event: EngineEvent,
): Promise<void> {
  if (event.type === "turn.completed") {
    const convId = this.conversationBySession.get(event.sessionId);
    const binding = convId ? this.bindings.get(convId) : undefined;
    if (binding && binding.runningTurnId === event.payload.turnId) {
      await this.updateConversation(binding.conversationId, {
        state: "idle",
      }).catch((error) =>
        this.opts.log.warn("idle before turn.completed failed", {
          error: String(error),
        }),
      );
    }
  }
  this.onEngineEvent(event);
}

export function onEngineEvent(this: HarnessCtx, event: EngineEvent) {
  for (const fn of this.feedListeners) {
    try {
      fn(event);
    } catch {
      // a feed subscriber must never break event dispatch
    }
  }
  const convId = this.conversationBySession.get(event.sessionId);
  /* Live stream for paired phones (D-#157): every engine event of a
     conversation-bound session is re-published on the relay, which
     re-emits it on the conversation's channel. Errors are swallowed —
     the phone heals itself via `session.events` replay. */
  if (convId) {
    this.opts.relay
      .request("engine.event", {
        conversationId: convId,
        sessionId: event.sessionId,
        event,
      })
      .catch(() => {});
  }
  const binding = convId ? this.bindings.get(convId) : undefined;
  if (binding && event.seq > binding.lastSeq) binding.lastSeq = event.seq;
  /* #346: an event from the session proves it is alive — reset the
     reaper clock and drop the suspended mark; the session.started/
     session.state cases below write `life` when the wire says more. */
  if (binding) {
    binding.lastActivity = Date.now();
    binding.suspended = false;
  }
  switch (event.type) {
    case "turn.started": {
      if (!binding) return;
      /* A new turn has not touched its ticket yet (D-#777). */
      binding.ticketTouched = false;
      binding.runningTurnId = event.payload.turnId;
      binding.textByTurn.set(event.payload.turnId, "");
      // The pick the turn actually runs on — engine truth for the footer's
      // `· model · effort · Fast` (issue #92 AC-4).
      if (
        event.payload.model ||
        event.payload.provider ||
        event.payload.effort ||
        event.payload.fast !== undefined
      ) {
        binding.pickByTurn.set(event.payload.turnId, {
          ...(event.payload.model ? { model: event.payload.model } : {}),
          ...(event.payload.provider
            ? { provider: event.payload.provider }
            : {}),
          ...(event.payload.effort ? { effort: event.payload.effort } : {}),
          ...(event.payload.fast !== undefined
            ? { fast: event.payload.fast }
            : {}),
        });
      }
      // `ref` proves which relay message this turn consumed — recorded so a
      // pending-tail redelivery can't re-prompt it, and so the turn's answer
      // posts under a dedupe key stable across reconnects.
      /* The stop window ends: this turn (prompted or engine-pumped) runs
         to completion — nothing queued or steer-pending is parked on it. */
      binding.stopRequested = false;
      binding.stopParked = false;
      if (binding.steerReconcileTimer) {
        clearTimeout(binding.steerReconcileTimer);
        binding.steerReconcileTimer = undefined;
      }
      /* #400: a Stop fired while this turn's bind was still in its awaits
         parked on `pendingInterrupts` — fire it now that the turn exists
         (the engine acks interrupted:true instead of dropping it). #403:
         the parked Stop's scope is the sends stamped at or before it —
         fire only on a turn they produced. A send made after the Stop
         (seq above `afterSeq`, or a re-Sent row in `stopExempt`) outranks
         it: its turn runs free and the park stays for the send it waits
         on. A ref-less or undatable turn can't be told apart from the
         stopped one — interrupt it, as before. */
      const refSeq = event.payload.ref
        ? this.seqOfMessage(binding.channelId, event.payload.ref)
        : undefined;
      const stopSeq = convId ? this.stopSeqs.get(convId) : undefined;
      const refExempt =
        convId && event.payload.ref
          ? this.exemptFromCurrentStop(convId, event.payload.ref)
          : false;
      if (
        convId &&
        this.pendingInterrupts.has(convId) &&
        !refExempt &&
        (stopSeq === undefined || refSeq === undefined || refSeq <= stopSeq)
      ) {
        this.pendingInterrupts.delete(convId);
        this.opts.log.info("interrupt requested", {
          conversationId: convId,
        });
        binding.stopRequested = true;
        const conn = this.engine;
        if (conn)
          void conn
            .request("interrupt", { sessionId: binding.sessionId })
            .catch((e) =>
              this.opts.log.warn("parked interrupt failed", {
                error: String(e),
              }),
            );
      }
      if (event.payload.ref) {
        binding.consumed.add(event.payload.ref);
        binding.turnSource.set(event.payload.turnId, event.payload.ref);
        /* A pumped steer became a real turn input — it's consumed now,
           not pending (a later Stop has no pending left to drop). */
        binding.steerPending = binding.steerPending.filter(
          (s) => s.messageId !== event.payload.ref,
        );
        /* #377: this turn proves the engine took the message — a copy
           parked in the queue by a transport-error re-queue (the socket
           dropped after the prompt landed) is dead; left in place the
           drain would mint a duplicate turn when this one ends. */
        if (binding.queue.some((m) => m.id === event.payload.ref))
          this.opts.log.warn("turn claimed queued copy", {
            turnId: event.payload.turnId,
            ref: event.payload.ref,
          });
        binding.queue = binding.queue.filter((m) => m.id !== event.payload.ref);
        /* #315 AC-4: the message behind this turn was removed while its
           steer or prompt raced in — the engine pumped it anyway.
           Interrupt the turn the ghost alone created instead of running
           removed text. */
        if (this.dismissed.has(event.payload.ref)) {
          const conn = this.engine;
          if (conn) {
            void conn
              .request("interrupt", { sessionId: binding.sessionId })
              .catch((e) =>
                this.opts.log.warn("removed-message interrupt failed", {
                  error: String(e),
                }),
              );
          }
        }
      }
      this.opts.sleep.acquire();
      this.updateConversation(binding.conversationId, {
        state: "active",
        /* #419: a fresh turn erases the last failure's card — a retry
           that made it this far worked. Same for the stopped word. */
        turnFailure: null,
        turnStopped: null,
        /* D-#772: a live turn starts clear. During replay `stuckDefer`
           is set and finishStuckReplay is the only writer — a clear
           here drops a still-stuck mark, and the later re-mark pushes
           a second time. */
        ...(binding.stuckDefer ? {} : { stuck: null }),
      }).catch(() => {});
      beginStuckTurn(this, binding);
      /* #422: a turn is running but named no step yet — the header reads
         "thinking" until the first tool.started replaces it. Waits stay:
         applyReplay raises openRequests before replaying this event, and
         a live wait must survive; leftovers can't exist — turn end and
         interruption both clear them. */
      binding.nowStep = "thinking";
      this.noteNow(binding);
      break;
    }
    case "session.titled": {
      /* #137: the engine named its session (derived → llm). Write it as the
         conversation title — a host "auto" write, so the relay drops it
         atomically once the row is user-named; the metaSeen check just
         skips a doomed write when we've already seen the rename. */
      if (!binding || !this.hasAutoTitle()) break;
      if (this.metaSeen.get(binding.conversationId)?.titleSource === "user")
        break;
      this.updateConversation(binding.conversationId, {
        title: event.payload.title,
      }).catch((error) =>
        this.opts.log.warn("engine title write failed", {
          error: String(error),
        }),
      );
      break;
    }
    case "session.started":
      /* #346 AC-4: a live session exists — fresh bind or a resume's
         reopen — the conversation's life is open. */
      if (binding) this.writeLife(binding.conversationId, "open");
      break;
    case "session.state":
      /* #346 AC-4: `closed` is the only persistent bit — suspend and
         stop alike; `running` stays client-derived, never stored (the
         prototype's rule — sessionLife, #344/#348). */
      if (binding && event.payload.state === "closed") {
        this.writeLife(binding.conversationId, "closed");
      }
      break;
    case "subagent.started":
      /* #346 AC-3: a session under a running subagent never suspends. */
      binding?.openSubagents.add(event.payload.subagentId);
      /* D-#772: a helper working is progress. The quiet window resets. */
      if (binding) noteStuckProgress(this, binding);
      break;
    case "subagent.completed":
      binding?.openSubagents.delete(event.payload.subagentId);
      if (binding) noteStuckProgress(this, binding);
      break;
    /* #583 AC-3: a live background job stamps its count on the row — the
       badge and the session feed it keeps alive survive a released
       session (relay-persisted like `turnStopped`). */
    case "job.started": {
      if (!binding) break;
      binding.runningJobs.add(event.payload.jobId);
      this.updateConversation(binding.conversationId, {
        bgJobs: binding.runningJobs.size,
      });
      /* D-#772: a job starting is a new step, same as its later output. */
      noteStuckProgress(this, binding);
      break;
    }
    case "job.output":
      if (binding) noteStuckProgress(this, binding);
      break;
    case "job.exited": {
      if (!binding) break;
      if (binding.runningJobs.delete(event.payload.jobId))
        this.updateConversation(binding.conversationId, {
          bgJobs: binding.runningJobs.size,
        });
      break;
    }
    case "turn.model":
      /* #790: the adapter reported the route answering this turn. An
         empty pick (a session on the engine's default, with no
         turn.started model) is that route — no note. A different route
         is a fallback: one note per route, and the pick the footer
         reads moves to whoever answered. The conversation's model stays. */
      if (binding) applyTurnModel(this, binding, event);
      break;
    case "session.note":
      /* Engine-authored note (a deferred model switch that failed at
         turn start). Surfaced as a system message; deduped by seq AND
         session — a rebound session restarts its seq at 1 (#92). */
      if (binding) {
        this.postSystem(
          binding,
          event.payload.text,
          `sys:${binding.conversationId}:note:${event.sessionId}:${event.seq}`,
        ).catch(() => {});
      }
      break;
    case "turn.delta":
      if (binding) {
        if (event.payload.stream === "text") {
          binding.textByTurn.set(
            event.payload.turnId,
            (binding.textByTurn.get(event.payload.turnId) ?? "") +
              event.payload.delta,
          );
        }
        /* D-#772: a streaming command is still moving. The quiet window
           resets on the delta, not only when the next tool starts. */
        noteStuckProgress(this, binding);
      }
      break;
    /* #431: a replayed finished turn's streams in one frame — replace
       the accumulation like the fold does so the turn still posts its
       answer at turn.completed. */
    case "turn.recap":
      binding?.textByTurn.set(event.payload.turnId, event.payload.text);
      break;
    /* tool.started/completed never post feed rows — the tool cards
       inside the turn are the single rendering (issue #71, AC-1). But
       tool.started IS the employee's live "now:" step (#422): the
       running tool + its target — the same arg pick the subagent row
       uses (`command ?? path ?? pattern ?? query`). */
    case "tool.started":
      if (binding) {
        if (/ticket_update/.test(event.payload.tool))
          binding.ticketTouched = true;
        const arg = String(
          event.payload.input.command ??
            event.payload.input.path ??
            event.payload.input.pattern ??
            event.payload.input.query ??
            "",
        );
        binding.nowStep = `${event.payload.tool} ${arg}`.trim();
        this.noteNow(binding);
        noteStuckTool(
          this,
          binding,
          {
            tool: event.payload.tool,
            input: event.payload.input,
            at: Date.now(),
          },
          event.payload.parentToolCallId !== undefined,
        );
      }
      break;
    case "tool.completed":
      /* D-#772: the call finishing is progress, including a nested one. */
      if (binding) {
        if (/ticket_update/.test(event.payload.tool))
          binding.ticketTouched = true;
        noteStuckProgress(this, binding);
      }
      break;
    case "request.opened":
      if (binding) {
        /* D-#106 AC-2: Full access is enforced here, engine-neutral — the
           harness answers `approval` requests itself (`once`) and the
           card never reaches the user; other kinds still surface. */
        if (
          binding.access === "full" &&
          event.payload.request.kind === "approval"
        ) {
          void this.autoApprove(
            binding,
            event.payload.requestId,
            event.payload.request,
          ).catch((error) =>
            this.opts.log.warn("auto-approve failed", {
              error: String(error),
            }),
          );
        } else {
          void this.openAsk(
            binding,
            event.payload.turnId,
            event.payload.requestId,
            event.payload.request,
          ).catch((error) =>
            this.opts.log.error("asks.open failed", {
              error: String(error),
            }),
          );
        }
      }
      break;
    case "request.resolved":
      if (binding) {
        binding.nowWaits.delete(event.payload.requestId);
        this.noteNow(binding);
        /* D-#772: the quiet window resumes only once nothing is left
           waiting on the user. The wait itself is not quiet time. */
        resumeStuckWatch(this, binding);
      }
      void this.onEngineRequestResolved(
        event.sessionId,
        event.payload.requestId,
        event.payload.outcome,
        event.payload.answer,
      );
      break;
    case "session.ref.changed":
      if (binding) {
        // Keep the rotated runtime ref on the binding only. The
        // conversation's engineRef stays the stable engine session id —
        // clients resolve it through the feed (`events.since`, live
        // `event.sessionId`), which never sees runtime refs.
        binding.ref = event.payload.ref;
        /* The rotated ref IS the engine's stored session id — keep the
           gateway alias current so plugin calls resolve this scope. */
        binding.engineSessionId = event.payload.ref;
        this.aliasSurfaces(binding.gatewaySession, event.payload.ref);
        this.opts.log.info("session ref rotated", {
          sessionId: event.sessionId,
          ref: event.payload.ref,
        });
      }
      break;
    case "session.compacted":
      /* D-#560: exactly one note per compaction — manual or automatic —
         with the before→after token drop when the engine measured it.
         Deduped by seq AND session like session.note: a rebound session
         restarts its seq at 1. `session.info` ref bumps and idle resumes
         never fire this event, so the note can't appear spuriously. The
         note is a persisted system message, so it replays with the thread.
         Not: inferring compaction from `session.ref.changed`, or matching
         the engine's notification text. */
      if (binding) {
        const { beforeTokens, afterTokens } = event.payload;
        const drop =
          beforeTokens !== undefined && afterTokens !== undefined
            ? ` (${fmtTokens(beforeTokens)} → ${fmtTokens(afterTokens)})`
            : "";
        this.postSystem(
          binding,
          `Context compacted: older turns summarized${drop}`,
          `sys:${binding.conversationId}:compacted:${event.sessionId}:${event.seq}`,
        ).catch(() => {});
      }
      break;
    case "turn.steered":
      /* The steer landed inside the turn — pair it to its relay message
         (payload carries text only) so it's no longer a pending steer. */
      if (binding) {
        const idx = binding.steerPending.findIndex(
          (s) => s.text === event.payload.text,
        );
        /* #550: no pending match means the landing outran its ack —
           engine-hermes emits this inside `session.steer`, so the event
           arrives before the response resolves. Record the text for the
           ack to claim; a landed steer is delivered, never parked. */
        if (idx >= 0) binding.steerPending.splice(idx, 1);
        else binding.steerLanded.push(event.payload.text);
        /* D-#772: a message that landed clears the mark and the count. */
        stuckOnNewMessage(this, binding);
      }
      break;
    case "turn.completed":
      if (binding) void this.finishTurn(binding, event);
      break;
    default:
      break;
  }
}

type CatalogRow = { id: string; name?: string; provider?: string };

/** #790: move the turn's pick to the route that answered. The first
    report on a turn that announced no model establishes that pick and
    is not a fallback. A repeated route stamps the footer without a
    second note. */
function applyTurnModel(
  ctx: HarnessCtx,
  binding: SessionBinding,
  event: Extract<EngineEvent, { type: "turn.model" }>,
) {
  const { turnId, model, provider, reason } = event.payload;
  const pick = binding.pickByTurn.get(turnId);
  if (!pick?.model) {
    binding.pickByTurn.set(turnId, {
      ...(pick ?? {}),
      model,
      ...(provider ? { provider } : {}),
    });
    return;
  }
  const changed =
    model !== pick.model ||
    (provider !== undefined && provider !== pick.provider);
  if (!changed) return;
  const asked = pick.model;
  const askedProvider = pick.provider;
  binding.pickByTurn.set(turnId, {
    ...pick,
    model,
    ...(provider !== undefined ? { provider } : {}),
  });
  binding.fellBackThisTurn = true;
  const last = binding.lastFallback;
  if (
    last?.model === model &&
    (last.provider ?? undefined) === (provider ?? undefined)
  )
    return;
  binding.lastFallback = { model, ...(provider ? { provider } : {}) };
  void explainFallback(ctx, binding, {
    fromId: asked,
    fromProvider: askedProvider,
    toId: model,
    toProvider: provider,
    reason,
    dedupeKey: `sys:${binding.conversationId}:fallback:${event.sessionId}:${turnId}`,
  });
}

async function explainFallback(
  ctx: HarnessCtx,
  binding: SessionBinding,
  o: {
    fromId: string;
    fromProvider?: string;
    toId: string;
    toProvider?: string;
    reason?: string;
    dedupeKey: string;
  },
) {
  const rows = await catalogRows(ctx);
  const names = fallbackNames(
    rows,
    o.fromId,
    o.fromProvider,
    o.toId,
    o.toProvider,
  );
  await ctx.postSystem(
    binding,
    fallbackTurnNote(names.from, names.to, o.reason),
    o.dedupeKey,
  );
}

function catalogRows(ctx: HarnessCtx): Promise<readonly CatalogRow[]> {
  if (!ctx.modelCatalog) {
    const conn = ctx.engine;
    ctx.modelCatalog = conn
      ? conn
          .request<{ models?: CatalogRow[] }>("models.list", {})
          .then((r) => r.models ?? [])
          .catch(() => [])
      : Promise.resolve([]);
  }
  return ctx.modelCatalog;
}

/** Catalog names. Identical names on two routes get the provider, and
    if that still collides, the raw ids (#790). */
function fallbackNames(
  rows: readonly CatalogRow[],
  fromId: string,
  fromProvider: string | undefined,
  toId: string,
  toProvider: string | undefined,
): { from: string; to: string } {
  const nameOf = (id: string, provider?: string) => {
    const exact = provider
      ? rows.find((m) => m.id === id && m.provider === provider)
      : undefined;
    const any = rows.find((m) => m.id === id);
    return (exact ?? any)?.name || id;
  };
  const fromName = nameOf(fromId, fromProvider);
  const toName = nameOf(toId, toProvider);
  if (fromName !== toName) return { from: fromName, to: toName };
  const labeled = (name: string, id: string, provider?: string) =>
    provider ? `${name} (${provider})` : id;
  const fromLabeled = labeled(fromName, fromId, fromProvider);
  const toLabeled = labeled(toName, toId, toProvider);
  if (fromLabeled !== toLabeled) return { from: fromLabeled, to: toLabeled };
  return { from: fromId, to: toId };
}
