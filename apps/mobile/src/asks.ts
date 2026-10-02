import { type AppClient, RelayError } from "@lilos/client-runtime";
import type { Ask } from "@lilos/contracts/app";
import type { ApprovalOutcome } from "@lilos/contracts/engine";
import * as Haptics from "expo-haptics";
import { Alert } from "react-native";
import { $asks } from "./dm-store";
import { describeError } from "./mapping";

/* #158: approving or denying an agent's pending ask from the phone — the
   same asks.respond the Mac sends. Prototype parity
   (prototype/mobile/src/App.tsx `decide`): the tap haptics first — success
   on approve, warning on deny — then the wire call. The resolved ask lands
   back in the shared atoms so every surface (thread card, Activity sheet,
   Needs-you accessory, DM grouping) folds within one update. */

/** yes/no -> the wire outcome this ask's kind accepts. A question can't be
    approved without free text, so its Approve pill hides and this returns
    undefined — decide() then refuses rather than shipping a bad respond. */
export function askOutcome(
  ask: Pick<Ask, "request">,
  approved: boolean,
): ApprovalOutcome | undefined {
  const kind = ask.request.kind;
  if (approved) {
    if (kind === "approval") return "once";
    if (kind === "plan") return "approve";
    return undefined;
  }
  if (kind === "approval") return "deny";
  if (kind === "plan") return "reject";
  return "cancel";
}

/** The wire shape decide needs — an AppClient satisfies it. */
export type DecideClient = Pick<AppClient, "request" | "asks">;

const inFlight = new Set<string>();

/** Replace-or-append an ask in both stores the surfaces read. */
function upsertAsk(client: DecideClient, ask: Ask): void {
  for (const store of [$asks, client.asks]) {
    const list = store.get();
    store.set(
      list.some((a) => a.id === ask.id)
        ? list.map((a) => (a.id === ask.id ? ask : a))
        : [...list, ask],
    );
  }
}

/** asks.list -> both stores (one update across thread/sheet/accessory). */
async function refreshAsks(client: DecideClient): Promise<void> {
  const res = await client.request<{ asks: Ask[] }>("asks.list", {});
  for (const store of [$asks, client.asks]) store.set(res.asks);
}

/** The ask a surface is deciding — either store, then a refresh. */
async function findAsk(
  client: DecideClient,
  askId: string,
): Promise<Ask | undefined> {
  const hit = (list: Ask[]) => list.find((a) => a.id === askId);
  const here = hit(client.asks.get()) ?? hit($asks.get());
  if (here) return here;
  await refreshAsks(client).catch(() => {});
  return hit(client.asks.get()) ?? hit($asks.get());
}

function respondError(e: unknown): string {
  if (e instanceof RelayError) return describeError(e);
  return "That didn't land — the request is still waiting on you.";
}

/* ── #182 plan asks ───────────────────────────────────────────────────────
   A `kind:"plan"` ask gates a proposed plan version: Approve/Reject answer
   it through the same decide() as approvals; Change instead carries the
   user's draft text back as `answer` (asks.respond outcome "change") and
   the engine posts the next version, which asks again. */

/** Composer prefill a Change tap leaves (web: PLAN_CHANGE_PREFIX). */
export const PLAN_CHANGE_PREFIX = "Change the plan: ";

/** The conversation's open plan ask, if one is waiting. */
export function openPlanAsk(
  asks: readonly Ask[],
  conversationId: string,
): Ask | undefined {
  return asks.find(
    (a) =>
      a.state === "open" &&
      a.conversationId === conversationId &&
      a.request.kind === "plan",
  );
}

/** Composer intercept: a draft still carrying the change prefix while a
    plan ask is open is that ask's answer — send it as outcome "change",
    never as a thread message. Returns undefined for a normal send. */
export function planChangeSend(
  text: string,
  asks: readonly Ask[],
  conversationId: string,
): { askId: string; answer: string } | undefined {
  if (!text.startsWith(PLAN_CHANGE_PREFIX)) return undefined;
  const ask = openPlanAsk(asks, conversationId);
  if (!ask) return undefined;
  return { askId: ask.id, answer: text.slice(PLAN_CHANGE_PREFIX.length) };
}

/* plan.updated lands in the feed a frame before the relay mints the ask —
   an Approve/Reject tap races `asks.open`, so poll the store briefly (the
   web awaitPlanAsk rule: up to ~3s at 50ms). */
export async function awaitPlanAsk(
  conversationId: string,
  planId?: string,
): Promise<Ask | undefined> {
  for (let i = 0; i < 60; i++) {
    const hit = $asks
      .get()
      .find(
        (a) =>
          a.state === "open" &&
          a.conversationId === conversationId &&
          a.request.kind === "plan" &&
          (planId === undefined || a.request.planId === planId),
      );
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

/** A Change reply: asks.respond outcome "change" carrying the draft text.
    Same conflict-quieting as decide() — answered elsewhere is done. */
export async function answerPlanChange(
  client: DecideClient,
  askId: string,
  answer: string,
): Promise<void> {
  if (inFlight.has(askId)) return;
  inFlight.add(askId);
  try {
    const { ask } = await client.request<{ ask: Ask }>("asks.respond", {
      askId,
      outcome: "change",
      answer,
    });
    upsertAsk(client, ask);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch (e) {
    if (e instanceof RelayError && e.code === "conflict") {
      await refreshAsks(client).catch(() => {});
      return;
    }
    Alert.alert("Couldn't send the change", respondError(e));
  } finally {
    inFlight.delete(askId);
  }
}

/**
 * Approve or deny one ask. Fires the decide haptic on the tap, sends
 * asks.respond, then folds the resolved ask into the stores. An ask already
 * answered elsewhere (Mac or an earlier tap) is "done", never an error.
 */
export async function decide(
  client: DecideClient,
  askId: string,
  approved: boolean,
): Promise<void> {
  if (inFlight.has(askId)) return;
  inFlight.add(askId);
  void Haptics.notificationAsync(
    approved
      ? Haptics.NotificationFeedbackType.Success
      : Haptics.NotificationFeedbackType.Warning,
  );
  try {
    const ask = await findAsk(client, askId);
    // Off the relay's list = already answered, here or on another device.
    if (!ask) return;
    const outcome = askOutcome(ask, approved);
    if (!outcome) return;
    try {
      const res = await client.request<{ ask: Ask }>("asks.respond", {
        askId: ask.id,
        outcome,
      });
      upsertAsk(client, res.ask);
    } catch (e) {
      // AC-3: another device beat this tap — re-pull and move on quietly.
      if (e instanceof RelayError && e.code === "conflict") {
        await refreshAsks(client).catch(() => {});
        return;
      }
      Alert.alert("Couldn't answer", respondError(e));
    }
  } finally {
    inFlight.delete(askId);
  }
}
