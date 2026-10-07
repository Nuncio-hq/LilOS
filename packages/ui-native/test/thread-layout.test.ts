import { describe, expect, it } from "vitest";
import { threadBottomInset } from "../src/employees/thread-layout";

/* #555: the transcript's last row must clear the floating bottom stack —
   composer plus whatever rides above it (background pill, unreachable
   note, not-sent tray, Remove's Undo toast), each with its 8px gap. A
   missing term overlaps the last row (vision review: the tray's top
   border ran through "You stopped this turn"). */
describe("threadBottomInset — tray + toast feed the bottom inset", () => {
  it("composer alone is the floor", () => {
    expect(threadBottomInset(96)).toBe(96);
  });

  it("adds the not-sent tray plus its stack gap while parked sends show", () => {
    expect(threadBottomInset(96, 0, 0, 72)).toBe(96 + 72 + 8);
  });

  it("adds the Undo toast plus its stack gap while the toast lives", () => {
    expect(threadBottomInset(96, 0, 0, 0, 40)).toBe(96 + 40 + 8);
  });

  it("uses the toast's onLayout-measured height, not a smaller floor", () => {
    /* Vision review: the fixed 40pt reserve left the pill flush against
       "You stopped this turn" — a real ~56pt pill needs its own number. */
    expect(threadBottomInset(96, 0, 0, 0, 56)).toBe(96 + 56 + 8);
  });

  it("stacks tray and toast together above the composer", () => {
    expect(threadBottomInset(96, 0, 0, 72, 40)).toBe(96 + 72 + 8 + 40 + 8);
  });

  it("skips a zero-height float (no gap for what isn't on screen)", () => {
    expect(threadBottomInset(96, 0, 0, 0, 0)).toBe(96);
  });
});
