import { describe, expect, it } from "vitest";
import {
  flyTarget,
  shouldClaimSwipe,
  swipeDecision,
} from "../src/v3/needs/swipe";

describe("shouldClaimSwipe", () => {
  it("claims a mostly sideways drag", () => {
    expect(shouldClaimSwipe(20, 5)).toBe(true);
    expect(shouldClaimSwipe(-20, 5)).toBe(true);
  });

  it("leaves vertical scrolling to the page", () => {
    expect(shouldClaimSwipe(10, 30)).toBe(false);
    expect(shouldClaimSwipe(12, 12)).toBe(false);
  });

  it("ignores a drag that has barely moved", () => {
    expect(shouldClaimSwipe(8, 0)).toBe(false);
    expect(shouldClaimSwipe(9, 0)).toBe(true);
  });
});

describe("swipeDecision", () => {
  const width = 300;

  it("approves right and denies left past 35% of the width", () => {
    expect(swipeDecision(106, 0, width)).toBe("approve");
    expect(swipeDecision(-106, 0, width)).toBe("deny");
  });

  it("springs back when released short and slow", () => {
    expect(swipeDecision(104, 0.1, width)).toBe("none");
    expect(swipeDecision(-60, 0, width)).toBe("none");
    expect(swipeDecision(0, 0, width)).toBe("none");
  });

  it("decides on a fling even before the threshold", () => {
    expect(swipeDecision(40, 0.9, width)).toBe("approve");
    expect(swipeDecision(-40, -0.9, width)).toBe("deny");
  });

  it("does not decide on a twitch", () => {
    expect(swipeDecision(10, 1.5, width)).toBe("none");
  });

  it("cancels when flicked back against the drag", () => {
    expect(swipeDecision(200, -0.9, width)).toBe("none");
    expect(swipeDecision(-200, 0.9, width)).toBe("none");
  });

  it("never decides without a width", () => {
    expect(swipeDecision(200, 1, 0)).toBe("none");
  });
});

describe("flyTarget", () => {
  it("sends a card clear of the screen on its own side", () => {
    expect(flyTarget("approve", 300)).toBe(450);
    expect(flyTarget("deny", 300)).toBe(-450);
  });
});
