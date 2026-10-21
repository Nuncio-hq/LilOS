import { describe, expect, it } from "vitest";
import {
  CEO_WAKE_COALESCE_MS,
  CeoWakes,
  formatCeoWake,
} from "../src/harness/ceo-wake.js";

/**
 * D-#777: one wake per burst, never the CEO's own action, and never a
 * second turn while one is running.
 */
describe("CEO wakes", () => {
  const ceo = "emp_ceo";

  it("coalesces events inside the window into one wake", () => {
    const wakes = new CeoWakes();
    expect(wakes.note({ reason: "done", ticketId: "LIL-1", at: 0 }, ceo)).toBe(
      "queued",
    );
    expect(
      wakes.note(
        { reason: "stuck", ticketId: "LIL-2", handTo: "emp_b", at: 500 },
        ceo,
      ),
    ).toBe("queued");
    expect(wakes.poll(1_000)).toBeNull();
    const batch = wakes.poll(CEO_WAKE_COALESCE_MS);
    expect(batch).toHaveLength(2);
    expect(batch?.[0]?.ticketId).toBe("LIL-1");
    expect(batch?.[1]?.ticketId).toBe("LIL-2");
    expect(wakes.poll(CEO_WAKE_COALESCE_MS + 1)).toBeNull();
  });

  it("drops the CEO's own action and drops everything when no one holds the seat", () => {
    const wakes = new CeoWakes();
    expect(
      wakes.note(
        { reason: "done", ticketId: "LIL-1", actorId: ceo, at: 0 },
        ceo,
      ),
    ).toBe("self");
    expect(wakes.poll(CEO_WAKE_COALESCE_MS)).toBeNull();
    expect(wakes.note({ reason: "done", ticketId: "LIL-1", at: 0 }, null)).toBe(
      "no-ceo",
    );
    expect(wakes.hasPending).toBe(false);
  });

  it("runs one turn at a time and releases the next when that turn settles", () => {
    const wakes = new CeoWakes();
    wakes.note({ reason: "done", ticketId: "LIL-1", at: 0 }, ceo);
    const first = wakes.poll(CEO_WAKE_COALESCE_MS);
    expect(first).toHaveLength(1);
    expect(wakes.isRunning).toBe(true);
    expect(
      wakes.note({ reason: "ask", ticketId: "LIL-3", at: 2_000 }, ceo),
    ).toBe("queued");
    expect(wakes.poll(9_000)).toBeNull();
    const next = wakes.settled();
    expect(next).toHaveLength(1);
    expect(next?.[0]?.reason).toBe("ask");
    expect(wakes.isRunning).toBe(true);
    expect(wakes.settled()).toBeNull();
    expect(wakes.isRunning).toBe(false);
  });

  it("lists every event on one wake", () => {
    const text = formatCeoWake([
      {
        reason: "done",
        ticketId: "LIL-1",
        at: 0,
        next: [{ ticketId: "LIL-2", ownerId: "emp_b" }],
      },
      { reason: "stuck", ticketId: "LIL-9", handTo: "emp_c", at: 1 },
    ]);
    expect(text).toBe(
      [
        "CEO wake.",
        "- finished LIL-1",
        "- next LIL-2 owner emp_b",
        "- stuck ticket LIL-9 hand emp_c",
      ].join("\n"),
    );
  });
});
