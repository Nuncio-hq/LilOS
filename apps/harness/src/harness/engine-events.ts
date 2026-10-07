import type { EngineEvent } from "@lilos/contracts/engine";
import type { HarnessCtx } from "./ctx";

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

export function onEngineEvent(this: HarnessCtx, event: EngineEvent) {
  for (const fn of this.feedListeners) {
    try {
      fn(event);
    } catch {
      // a feed subscriber must never break event dispatch
    }
  }
  const convId = this.conversationBySession.get(event.sessionId);
  /* Live stream for paired phones (#157): every engine event of a
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
      }).catch(() => {});
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
      break;
    case "subagent.completed":
      binding?.openSubagents.delete(event.payload.subagentId);
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
      break;
    }
    case "job.exited": {
      if (!binding) break;
      if (binding.runningJobs.delete(event.payload.jobId))
        this.updateConversation(binding.conversationId, {
          bgJobs: binding.runningJobs.size,
        });
      break;
    }
    case "session.note":
      /* Engine-authored note (e.g. a deferred model switch that failed at
         turn start — "Couldn't switch to X — staying on Y"). Surfaced as a
         system message; deduped by seq AND session — a rebound session
         restarts its seq at 1 (#92). */
      if (binding) {
        this.postSystem(
          binding,
          event.payload.text,
          `sys:${binding.conversationId}:note:${event.sessionId}:${event.seq}`,
        ).catch(() => {});
      }
      break;
    case "turn.delta":
      if (binding && event.payload.stream === "text") {
        binding.textByTurn.set(
          event.payload.turnId,
          (binding.textByTurn.get(event.payload.turnId) ?? "") +
            event.payload.delta,
        );
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
        const arg = String(
          event.payload.input.command ??
            event.payload.input.path ??
            event.payload.input.pattern ??
            event.payload.input.query ??
            "",
        );
        binding.nowStep = `${event.payload.tool} ${arg}`.trim();
        this.noteNow(binding);
      }
      break;
    case "request.opened":
      if (binding) {
        /* #106 AC-2: Full access is enforced here, engine-neutral — the
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
      }
      break;
    case "turn.completed":
      if (binding) void this.finishTurn(binding, event);
      break;
    default:
      break;
  }
}
