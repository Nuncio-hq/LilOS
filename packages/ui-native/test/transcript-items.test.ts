import { describe, expect, it } from "vitest";
import { transcriptItems } from "../src/employees/transcript-items";
import type { ThreadEntry } from "../src/employees/types";

/* #514: the trimmed note describes history missing ABOVE the first visible
   message, so it must head the transcript — a user scrolling up for old
   messages meets the explanation, not a silent gap (#431). */

const entry = (id: string, time = "16:40"): ThreadEntry => ({
  kind: "user",
  id,
  time,
  text: `message ${id}`,
});

describe("transcriptItems — #514 trimmed note order", () => {
  it("note present → first item is the note, entries follow in order", () => {
    const items = transcriptItems({
      transcriptNote:
        "Earlier history was trimmed — this session's event log is capped.",
      entries: [entry("a"), entry("b"), entry("c")],
    });
    expect(items.map((i) => i.kind)).toEqual([
      "transcript-note",
      "user",
      "user",
      "user",
    ]);
    expect(items[1].id).toBe("a");
    expect(items[0]).toMatchObject({
      kind: "transcript-note",
      text: "Earlier history was trimmed — this session's event log is capped.",
    });
  });

  it("no note → first item is the first entry, nothing injected", () => {
    const items = transcriptItems({ entries: [entry("a"), entry("b")] });
    expect(items.map((i) => i.kind)).toEqual(["user", "user"]);
    expect(items[0].id).toBe("a");
  });
});
