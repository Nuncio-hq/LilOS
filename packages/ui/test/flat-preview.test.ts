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

describe("issue #417", () => {
  test("AC-1 inline code and snake_case identifiers keep their underscores", () => {
    const out = preview(
      "Set `LILOS_ENGINE` to hermes, then read foo_bar_baz from the config.",
    );
    expect(out).toBe(
      "Set LILOS_ENGINE to hermes, then read foo_bar_baz from the config.",
    );
  });

  test("AC-1 bare identifiers keep underscores outside code spans too", () => {
    expect(preview("run LILOS_ENGINE=hermes with conv_338a111f")).toBe(
      "run LILOS_ENGINE=hermes with conv_338a111f",
    );
  });

  test("AC-2 real emphasis like _this_ still previews as plain text", () => {
    expect(preview("ran _this_ check first")).toBe("ran this check first");
  });
});
