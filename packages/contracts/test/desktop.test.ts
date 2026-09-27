/**
 * Issue #32 — desktop bridge contract: the notification shape crossing
 * renderer → Electron main is validated at the boundary.
 */
import { describe, expect, it } from "vitest";
import { DesktopNotification } from "../src/app/desktop";

describe("AC-1/AC-2 desktop notification contract", () => {
  it("parses a valid notification", () => {
    const n = DesktopNotification.parse({
      conversationId: "c1",
      kind: "ask",
      title: "Builder needs your approval",
      body: "git push",
    });
    expect(n.kind).toBe("ask");
    expect(n.conversationId).toBe("c1");
  });

  it("rejects unknown kinds and missing conversation", () => {
    expect(
      DesktopNotification.safeParse({
        conversationId: "c1",
        kind: "nudge",
        title: "x",
      }).success,
    ).toBe(false);
    expect(
      DesktopNotification.safeParse({ kind: "done", title: "x" }).success,
    ).toBe(false);
    expect(
      DesktopNotification.safeParse({
        conversationId: "",
        kind: "done",
        title: "x",
      }).success,
    ).toBe(false);
  });
});
