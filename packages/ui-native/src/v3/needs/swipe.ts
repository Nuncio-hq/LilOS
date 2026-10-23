/* The arithmetic behind swiping an ask card: when a drag claims the gesture,
   when a release counts as a decision, and where a decided card flies to.
   Pure so the thresholds are testable without a device. */

export type SwipeDecision = "approve" | "deny" | "none";

/** A drag past this share of the card's width decides, even when slow. */
export const DECIDE_DISTANCE_RATIO = 0.35;
/** A flick faster than this (px per ms, as PanResponder reports it) decides. */
export const FLING_VELOCITY = 0.6;
/** …but only after the finger has really moved: a twitch is not a decision. */
export const FLING_MIN_DISTANCE = 24;
/** The drag must travel this far sideways before the card claims it. */
export const CLAIM_MIN_DX = 8;

/** The card claims a drag only when it is mostly sideways, so the page still
    scrolls vertically (and Maestro's horizontal swipe still lands). */
export function shouldClaimSwipe(dx: number, dy: number): boolean {
  return Math.abs(dx) > CLAIM_MIN_DX && Math.abs(dx) > Math.abs(dy);
}

/** What releasing at `dx` with horizontal velocity `vx` means. Right is
    approve, left is deny. A flick back against the drag cancels it. */
export function swipeDecision(
  dx: number,
  vx: number,
  width: number,
): SwipeDecision {
  if (width <= 0 || dx === 0) return "none";
  const side = Math.sign(dx);
  const fast = Math.abs(vx) >= FLING_VELOCITY;
  if (fast && Math.sign(vx) !== side) return "none";
  const far = Math.abs(dx) >= width * DECIDE_DISTANCE_RATIO;
  const flung = fast && Math.abs(dx) >= FLING_MIN_DISTANCE;
  if (!far && !flung) return "none";
  return side > 0 ? "approve" : "deny";
}

/** Where a decided card ends up: clear of the screen on its own side. */
export function flyTarget(
  decision: Exclude<SwipeDecision, "none">,
  width: number,
): number {
  return (decision === "approve" ? 1 : -1) * width * 1.5;
}
