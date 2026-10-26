import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * D-#764 — the seam guard: nothing under src/ may branch on an agent's
 * identity. Capabilities come from `initialize`/`session/new` advertising,
 * never from a vendor name — the whole point of one shared mapping is that
 * `devin acp`, `claude … acp`, or the next runtime needs no seam changes.
 *
 * The check is source-level: a name appearing as a string literal or an
 * identifier in a comparison is the failure shape. (The only legitimate
 * mentions are comments — those are stripped before the scan.)
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const VENDOR_WORDS =
  /\b(hermes|devin|claude|codex|cursor|opencode|antigravity)\b/i;

const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("no per-agent branches in the seam package (D-#764)", () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
  test("src files exist to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const f of files) {
    test(`${f} names no agent/vendor outside comments`, () => {
      const code = stripComments(readFileSync(join(SRC, f), "utf8"));
      const hit = code.match(VENDOR_WORDS);
      expect(hit, `${f} mentions ${hit?.[0]} at ${hit?.index}`).toBeNull();
    });
  }
});
