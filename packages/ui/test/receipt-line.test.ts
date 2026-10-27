/* Issue #891: an auto-approved receipt reads as the same sentence the approval
   card shows — "Auto-approved: Edit README.md (Full access)" — never raw JSON,
   with the engine command kept for the Details disclosure. */
import { describe, expect, test } from "vitest";
import { summariseReceipt } from "../src/conversation/receipt-line";

describe("issue #891 — summariseReceipt()", () => {
  test("patch → Edit <file> with the raw command under Details", () => {
    expect(
      summariseReceipt(
        'Auto-approved `patch {"path":"README.md"}` — Full access',
      ),
    ).toEqual({
      text: "Auto-approved: Edit README.md (Full access)",
      details: 'patch {"path":"README.md"}',
    });
  });

  test("write → Write <file> with the raw command under Details", () => {
    expect(
      summariseReceipt(
        'Auto-approved `write_file {"path":"docs/notes.md"}` — Full access',
      ),
    ).toEqual({
      text: "Auto-approved: Write docs/notes.md (Full access)",
      details: 'write_file {"path":"docs/notes.md"}',
    });
  });

  test("shell command → Run `cmd` with the raw command under Details", () => {
    expect(
      summariseReceipt(
        'Auto-approved `terminal {"command":"bun run verify","cwd":"/Users/x/lilos"}` — Full access',
      ),
    ).toEqual({
      text: "Auto-approved: Run `bun run verify` (Full access)",
      details: 'terminal {"command":"bun run verify","cwd":"/Users/x/lilos"}',
    });
  });

  test("a command containing backticks is captured whole", () => {
    const receipt = summariseReceipt(
      'Auto-approved `terminal {"command":"echo `date`"}` — Full access',
    );
    expect(receipt?.details).toBe('terminal {"command":"echo `date`"}');
  });

  test("notes that are not receipts pass through untouched", () => {
    expect(summariseReceipt("Stopped.")).toBeUndefined();
    expect(summariseReceipt("Auto-approved — Full access")).toBeUndefined();
    expect(summariseReceipt("Auto-approved: read only")).toBeUndefined();
  });
});
