/* #138/#570: landing a jump-to-hit on a lazy thread. scrollIntoView alone
   races twice:

   1. An in-flight bottom spring can overwrite the native write before its
      scroll event dispatches — the coalesced event then reads the
      spring's position, no escape lands, and the port is dragged back to
      the bottom (CI: ac-570's jump target "not found"). Escaping on the
      pin BEFORE the jump — the guard's own `escaped` flag plus the
      mutable state, the same moves the find window makes at open —
      leaves nothing to overwrite the write, and hydration commits along
      the way stand down (`escaped.v` stays set).
   2. Born-stubs around the target keep hydrating after the jump lands —
      every estimate→real swap drifts the row's viewport position. The
      frame loop re-lands the row whenever drift pushes it out of the
      port and retires once its offset goes quiet (each stub hydrates
      once — the wave is finite) or a newer jump takes over. */
import type { ConversationPin } from "../components/ai-elements/conversation";

let jumpGen = 0;

export function landJump(el: Element, pin: ConversationPin | null): void {
  const port = el.closest('[role="log"]');
  if (pin) {
    /* The jump is reader intent wherever the row sits. Escaping only for
       an above-the-port target assumed an in-view row was already landed
       — but on a jump mount the doc is still growing, so a "visible" row
       is just waiting to be pushed out of the port, and a still-engaged
       pin re-pins over the landing (ac-570's held-stub target: the hit's
       row streamed in early, sat in view at top=0, escaped nothing, then
       the finished doc dragged the port to the bottom). The guard's
       near-bottom reset re-engages the pin when the landing really is
       the bottom edge, so an unconditional escape costs a bottom hit
       nothing. */
    pin.escaped.v = true;
    pin.state.escapedFromLock = true;
    pin.state.isAtBottom = false;
  }
  el.scrollIntoView({ block: "center" });

  const gen = ++jumpGen;
  /* The loop owns the port until it retires — the guard reads this so
     near-bottom noise can't wipe the jump's escape mid-landing. Only the
     owning generation clears it. */
  if (pin) pin.jumping.v = gen;
  const retire = () => {
    if (pin && pin.jumping.v === gen) pin.jumping.v = 0;
  };
  let still = 0;
  let lastOff = Number.NaN;
  let frames = 0;
  const step = () => {
    if (gen !== jumpGen || ++frames > 240 || !el.isConnected) {
      retire();
      return;
    }
    const rect = port?.getBoundingClientRect();
    if (!rect) {
      retire();
      return;
    }
    const r = el.getBoundingClientRect();
    const off = r.top - rect.top;
    if (r.top < rect.top || r.bottom > rect.bottom) {
      el.scrollIntoView({ block: "center" });
      still = 0;
    } else if (off === lastOff) {
      if (++still >= 8) {
        retire();
        return;
      }
    } else {
      still = 0;
    }
    lastOff = off;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
