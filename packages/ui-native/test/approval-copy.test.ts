import { describe, expect, it } from "vitest";
import { approvalSentence } from "../src/employees/approval-copy";

/* #264: the card's one sentence — "<employee> wants to run" when the ask's
   reason is only the command echoed back (the engine's own "wants to run:
   <cmd>" template or the raw command); a reason that says something else is
   a real why and stays. */

describe("approvalSentence — the card says the command once", () => {
  it("a reason that is the command reads '<employee> wants to run'", () => {
    expect(
      approvalSentence({
        employee: "Ada",
        reason: "git commit -m 'ship it'",
        command: "git commit -m 'ship it'",
      }),
    ).toBe("Ada wants to run");
  });

  it("an engine description echoing the command also reads '<employee> wants to run'", () => {
    expect(
      approvalSentence({
        employee: "Ada",
        reason: "terminal wants to run: git commit -m 'ship it'",
        command: "git commit -m 'ship it'",
      }),
    ).toBe("Ada wants to run");
  });

  it("a reason that is a real why — not the command — stays", () => {
    expect(
      approvalSentence({
        employee: "Ada",
        reason: "Needs the migration in before the relay tests can pass.",
        command: "bun run db:migrate --env dev",
      }),
    ).toBe("Needs the migration in before the relay tests can pass.");
  });

  it("no command (question/file ask) → the reason as-is", () => {
    expect(
      approvalSentence({ employee: "Ada", reason: "Keep it or drop it?" }),
    ).toBe("Keep it or drop it?");
  });
});
