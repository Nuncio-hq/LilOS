import {
  AsksListParams,
  AsksOpenParams,
  AsksRespondParams,
} from "@lilos/contracts/app";
import type { RelayCtx } from "./ctx";
import { wakeSnoozed } from "./park";
import { badParams, JsonRpcCode, RpcError } from "./rpc";

/**
 * Moved verbatim out of `../session.ts`'s handle() (#441) — case
 * bodies are byte-identical modulo re-indentation. Returns `false`
 * when `method` belongs to another namespace; `undefined` once handled.
 */
export async function handleAsks(c: RelayCtx): Promise<false | undefined> {
  const {
    method,
    peer,
    id,
    params,
    options,
    store,
    log,
    broadcast,
    requireHost,
    respond,
  } = c;
  switch (method) {
    case "asks.open": {
      const parsed = AsksOpenParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      requireHost(peer);
      const { ask, created } = await store.createAsk(parsed.data);
      if (created) {
        /* D-#773: Needs you is one company-wide list. Channel subscribers
           used to be the only listeners, so each client derived its inbox
           per thread. A broadcast reaches every helloed client; a late
           joiner still gets the channel's current asks from
           `channel.subscribe`. Do not also emit — a subscribed peer would
           see the ask twice. */
        broadcast("ask.opened", {
          channelId: ask.channelId,
          ask,
        });
        /* D-#862: the ask is a needs-you transition — it wakes a snoozed
           thread early (its push still goes out; Needs-you is the one
           kind a snooze never silences). */
        await wakeSnoozed(c, ask.conversationId);
        /* #161: a created ask IS the needs-you transition — push. A
           replayed open returns created=false, so a host retry can't
           re-notify. Fire-and-forget: push never blocks the relay. */
        options.push
          ?.askOpened(ask)
          .catch((error) => log(`push fan-out failed: ${error}`));
      }
      respond(peer, id, { ask });
      return;
    }
    case "asks.respond": {
      const parsed = AsksRespondParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const existing = await store.getAsk(parsed.data.askId);
      if (!existing) {
        throw new RpcError(JsonRpcCode.notFound, "not_found", "ask not found");
      }
      if (existing.state === "resolved") {
        throw new RpcError(
          JsonRpcCode.conflict,
          "conflict",
          "ask already resolved",
        );
      }
      // The relay doesn't interpret engine asks, but it does enforce the
      // outcome/kind pairing the engine contract declares, so a malformed
      // answer can't be stored and replayed.
      const { kind } = existing.request;
      const outcome = parsed.data.outcome;
      const valid =
        kind === "approval"
          ? outcome !== "answer"
          : kind === "plan"
            ? /* #180: a plan ask answers approve / reject / change
                 (with text) — never the question kind's "answer". */
              outcome === "approve" ||
              outcome === "reject" ||
              outcome === "change" ||
              outcome === "cancel"
            : outcome === "answer" || outcome === "cancel";
      if (!valid) {
        throw new RpcError(
          JsonRpcCode.invalidParams,
          "invalid_params",
          `outcome ${outcome} is not valid for a ${kind} ask`,
        );
      }
      if (
        (outcome === "answer" || outcome === "change") &&
        !parsed.data.answer
      ) {
        throw new RpcError(
          JsonRpcCode.invalidParams,
          "invalid_params",
          `outcome ${outcome} requires an answer`,
        );
      }
      const ask = await store.resolveAsk(existing.id, {
        outcome,
        answer: parsed.data.answer,
      });
      if (ask) {
        broadcast("ask.resolved", {
          channelId: ask.channelId,
          ask,
        });
      }
      respond(peer, id, { ask });
      return;
    }
    case "asks.list": {
      const parsed = AsksListParams.safeParse(params ?? {});
      if (!parsed.success) throw badParams(parsed.error.issues);
      respond(peer, id, { asks: await store.listAsks(parsed.data) });
      return;
    }
    default:
      return false;
  }
}
