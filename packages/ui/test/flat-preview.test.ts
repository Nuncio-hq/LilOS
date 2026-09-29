/* Issue #261, ui layer: AC the flattened one-line reply preview must not put
   an orphan "·" right after a lead-in colon ("Short answer: · bullet…"). */
import { describe, expect, test } from "vitest";
import { preview } from "../src/lib/helpers";

describe("issue #261", () => {
  test("AC a colon lead-in joins its first bullet with a space, not ' · '", () => {
    const out = preview(
      "Short answer:\n\n- The contracts already carry `seq`.\n- Typecheck is clean.\n\nIf you want me to change code, pick a folder.",
    );
    expect(out).not.toMatch(/:\s*·/);
    expect(out).toBe(
      "Short answer: The contracts already carry seq. · Typecheck is clean. · If you want me to change code, pick a folder.",
    );
  });
});
