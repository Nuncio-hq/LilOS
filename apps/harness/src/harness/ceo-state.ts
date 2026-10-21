import { CeoWakes } from "@lilos/contracts/harness";
import type { HarnessCtx } from "./ctx";

/**
 * The standing CEO loop's memory (D-#777). One record per harness.
 * Routing decides when a wake leaves; delivery posts it. They share
 * this record so neither file has to own the other.
 */
export interface CeoLoop {
  wakes: CeoWakes;
  timer?: ReturnType<typeof setTimeout>;
  threadId?: string;
  /** Channel of a standing thread being opened, before its id is known. */
  openingChannelId?: string;
  ceoId: string | null;
  /** Set once settings have named the holder, so a late load cannot
      overwrite a change that landed while the first read was in flight. */
  touched: boolean;
  sawActive: boolean;
  ready: Promise<void>;
  resolveReady: () => void;
}

const loops = new WeakMap<HarnessCtx, CeoLoop>();

export function ceoLoop(ctx: HarnessCtx): CeoLoop {
  let found = loops.get(ctx);
  if (!found) {
    let resolveReady = () => {};
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    found = {
      wakes: new CeoWakes(),
      ceoId: null,
      touched: false,
      sawActive: false,
      ready,
      resolveReady,
    };
    loops.set(ctx, found);
  }
  return found;
}

/** The record if this harness has one. `stop` must not create one. */
export function ceoLoopOf(ctx: HarnessCtx): CeoLoop | undefined {
  return loops.get(ctx);
}

export function dropTimer(state: CeoLoop): void {
  if (!state.timer) return;
  clearTimeout(state.timer);
  state.timer = undefined;
}

export function forgetStanding(state: CeoLoop): void {
  state.threadId = undefined;
  state.openingChannelId = undefined;
  state.sawActive = false;
}

/** Busy means a send now would join a turn already going: the row is
    active, a prompt is in flight, or the binding still holds a queue.
    Not only a turn this loop started — the owner's own message counts
    (D-#777). */
export function ceoBusy(ctx: HarnessCtx, state: CeoLoop): boolean {
  if (state.openingChannelId) return true;
  const id = state.threadId;
  if (!id) return false;
  if ((ctx.inFlightDeliveries.get(id) ?? 0) > 0) return true;
  const binding = ctx.bindings.get(id);
  if (
    binding &&
    (binding.runningTurnId ||
      binding.queue.length > 0 ||
      binding.inflightPrompts.size > 0)
  ) {
    return true;
  }
  return ctx.conversationFromAtom(id)?.state === "active";
}
