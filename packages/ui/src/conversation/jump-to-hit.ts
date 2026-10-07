/* #138/#570: landing a jump-to-hit on a lazy thread. scrollIntoView alone
   races twice:

   1. An in-flight bottom spring can overwrite the native write before its
      scroll event dispatches — the coalesced event then reads the
      spring's position, no escape lands, and the port is dragged back to
      the bottom (CI: ac-570's jump target "not found"). Releasing the pin
      BEFORE the jump — straight on the mutable state, the same move the
      find window makes at open — leaves nothing to overwrite the write.
   2. Born-stubs around the target keep hydrating after the jump lands —
      every estimate→real swap drifts the row's viewport position. The
      frame loop re-lands the row whenever drift pushes it out of the
      port and retires once its offset goes quiet (each stub hydrates
      once — the wave is finite) or a newer jump takes over. */
import type { StickToBottomState } from "use-stick-to-bottom";

let jumpGen = 0;

export function landJump(el: Element, pin: StickToBottomState | null): void {
  const port = el.closest('[role="log"]');
  const pr = port?.getBoundingClientRect();
  if (pin?.isAtBottom && pr && el.getBoundingClientRect().top < pr.top) {
    /* The jump goes up — escape now, synchronously: the write about to
       land can no longer be overwritten by the spring. A downward or
       already-visible hit keeps the pin as it was. */
    pin.escapedFromLock = true;
    pin.isAtBottom = false;
  }
  el.scrollIntoView({ block: "center" });

  const gen = ++jumpGen;
  let still = 0;
  let lastOff = Number.NaN;
  let frames = 0;
  const step = () => {
    if (gen !== jumpGen || ++frames > 240 || !el.isConnected) return;
    const rect = port?.getBoundingClientRect();
    if (!rect) return;
    const r = el.getBoundingClientRect();
    const off = r.top - rect.top;
    if (r.top < rect.top || r.bottom > rect.bottom) {
      el.scrollIntoView({ block: "center" });
      still = 0;
    } else if (off === lastOff) {
      if (++still >= 8) return;
    } else {
      still = 0;
    }
    lastOff = off;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
