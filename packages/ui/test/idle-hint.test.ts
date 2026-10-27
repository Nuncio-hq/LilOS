import { describe, expect, test } from "vitest";
import { idleHint } from "../src/thread/idle-hint";

/* #886 took the idle line off the composer row; these are its words, kept
   for the folder kicker's tooltip. */
const merged = { status: "merged", number: 12, head: "feat/x" } as const;

describe("idleHint", () => {
  test("a branch: edits go to it", () => {
    expect(
      idleHint({ work: { branch: "feat/x" }, isDM: true, session: false }),
    ).toBe("Edits go to ⎇ feat/x");
  });

  test("a merged PR: the next edit starts a new branch", () => {
    expect(
      idleHint({
        work: { branch: "feat/x" },
        pr: merged,
        isDM: true,
        session: true,
      }),
    ).toBe(
      "#12 merged, ⎇ feat/x deleted · next edit starts a new branch from main",
    );
    // An open PR does not change the line.
    expect(
      idleHint({
        work: { branch: "feat/x" },
        pr: { ...merged, status: "open" },
        isDM: true,
        session: true,
      }),
    ).toBe("Edits go to ⎇ feat/x");
  });

  test("a folder with no branch, per frame", () => {
    expect(idleHint({ work: {}, isDM: false, session: true })).toBe(
      "Edits land in this folder",
    );
    expect(idleHint({ work: {}, isDM: false, session: false })).toBe(
      "Ticket only. No repo on this channel.",
    );
  });

  test("no work: read-only on main where there is a repo to read", () => {
    expect(idleHint({ work: null, isDM: false, session: true })).toBe(
      "Read-only on main",
    );
    expect(
      idleHint({ work: null, repo: "lilos", isDM: false, session: false }),
    ).toBe("Read-only on main. Start work to edit code.");
    expect(
      idleHint({ work: null, isDM: false, session: false }),
    ).toBeUndefined();
  });

  test("a plain chat has no repo to be read-only on", () => {
    expect(
      idleHint({ work: null, repo: "lilos", isDM: true, session: false }),
    ).toBeUndefined();
    expect(idleHint({ work: null, isDM: true, session: true })).toBeUndefined();
  });
});
