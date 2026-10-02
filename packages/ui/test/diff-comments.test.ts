import { describe, expect, it } from "vitest";
import {
  anchorVisible,
  diffCommentsMessage,
  diffSendRoute,
} from "../src/lib/diff-comments";
import type { DiffComment } from "../src/types";

const c = (p: Partial<DiffComment>): DiffComment => ({
  id: "dc-x",
  path: "packages/contracts/src/envelope.ts",
  side: "b",
  start: 3,
  end: 3,
  lines: ["+  seq: z.number().int().positive(),"],
  text: "rename this",
  ...p,
});

describe("AC-2 diffCommentsMessage — one message, path:line + quoted lines", () => {
  it("lists a single-line comment with its quoted code", () => {
    const msg = diffCommentsMessage([c({})]);
    expect(msg).toBe(
      "Review comments on the diff:\n\n" +
        "packages/contracts/src/envelope.ts:3\n" +
        "+  seq: z.number().int().positive(),\n" +
        "rename this",
    );
  });

  it("lists a range as path:start-end quoting every selected row", () => {
    const msg = diffCommentsMessage([
      c({
        start: 3,
        end: 5,
        lines: [
          "+  seq: z.number().int().positive(),",
          "+  // per-connection, strictly increasing",
          "   kind: z.string(),",
        ],
        text: "why?",
      }),
    ]);
    expect(msg).toContain("packages/contracts/src/envelope.ts:3-5\n");
    expect(msg).toContain("+  seq: z.number().int().positive(),\n");
    expect(msg).toContain("   kind: z.string(),\n");
    expect(msg).toContain("\nwhy?");
  });

  it("joins multiple comments into one message in pin order", () => {
    const msg = diffCommentsMessage([
      c({ id: "dc-1", path: "a.ts", text: "first" }),
      c({ id: "dc-2", path: "b.ts", start: 9, end: 9, text: "second" }),
    ]);
    expect(msg.split("\n\n").length).toBe(3); // header + two comments
    expect(msg.indexOf("a.ts:3")).toBeLessThan(msg.indexOf("b.ts:9"));
    expect(msg).toMatch(/^Review comments on the diff:/);
  });
});

describe("AC-3 diffSendRoute — the composer's steer-vs-queue rule", () => {
  it("steers mid-turn when the engine declares the capability", () => {
    expect(diffSendRoute(true, true)).toBe("steer");
  });
  it("queues as the next prompt mid-turn without the capability", () => {
    expect(diffSendRoute(true, false)).toBe("queue");
  });
  it("starts a fresh prompt when no turn runs", () => {
    expect(diffSendRoute(false, true)).toBe("prompt");
    expect(diffSendRoute(false, false)).toBe("prompt");
  });
});

describe("AC-1/AC-4 anchorVisible + prune semantics", () => {
  const patch =
    "@@ -2,3 +2,4 @@\n" +
    " export const Envelope = z.object({\n" +
    "-  seq: z.number().int().nonnegative(),\n" +
    "+  seq: z.number().int().positive(),\n" +
    "+  // per-connection, strictly increasing\n" +
    "   kind: z.string(),";

  it("sees a b-side anchor while its line is still in the patch", () => {
    expect(anchorVisible(c({ start: 3, end: 3 }), patch)).toBe(true);
    expect(anchorVisible(c({ start: 3, end: 5 }), patch)).toBe(true);
    expect(anchorVisible(c({ start: 3, end: 9 }), patch)).toBe(false);
  });

  it("sees an a-side (deleted) anchor on old-file numbers", () => {
    expect(
      anchorVisible(
        c({
          side: "a",
          start: 3,
          end: 3,
          lines: ["-  seq: z.number().int().nonnegative(),"],
        }),
        patch,
      ),
    ).toBe(true);
  });
});
