import { describe, expect, test } from "vitest";
import { parseUpdates } from "../src/work";

/* Updates stored before authorKind existed still read. A row with no
   person is LilOS, not the owner. */
describe("parseUpdates", () => {
  test("a legacy comment keeps its person; a bare row is the system", () => {
    const rows = parseUpdates(
      JSON.stringify([
        { id: "u1", by: "you", at: 1, text: "Looked at it" },
        { id: "u2", by: "emp_1", at: 2, text: "On it" },
        { id: "u3", at: 3, text: "LIL-1 is done, so this can move." },
      ]),
    );
    expect(rows[0]).toMatchObject({ authorKind: "user", by: "you" });
    expect(rows[1]).toMatchObject({ authorKind: "employee", by: "emp_1" });
    expect(rows[2]).toEqual({
      id: "u3",
      authorKind: "system",
      at: 3,
      text: "LIL-1 is done, so this can move.",
    });
  });
});
