import { RelayError } from "@lilos/client-runtime";
import { describe, expect, it } from "vitest";
import { describeError } from "../src/mapping";

/* #600: a failed action's body says "your Mac" and never leaks "relay" or
   a hardcoded "send" — each Alert's own title carries the verb
   ("Couldn't stop", "Couldn't load the thread"). */
describe("describeError (#600)", () => {
  it("not_connected/timeout read 'your Mac'", () => {
    for (const code of ["not_connected", "timeout"]) {
      const line = describeError(new RelayError("x", code));
      expect(line).toBe("Can't reach your Mac — try again.");
      expect(line).not.toContain("relay");
    }
  });

  it("everything else is a generic Mac line — no 'send', no 'relay'", () => {
    for (const line of [
      describeError(new RelayError("x", "invalid_params")),
      describeError(new Error("boom")),
      describeError("boom"),
    ]) {
      expect(line).toBe("Something went wrong on your Mac — try again.");
      expect(line).not.toContain("relay");
      expect(line).not.toContain("send");
    }
  });
});
