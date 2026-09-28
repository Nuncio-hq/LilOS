import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Issue #118 AC-1: the shipped placeholder identity is gone from `apps/*`
 * and `packages/ui` — every surface renders the relay-stored identity
 * instead. The needles are assembled piecewise so this test does not flag
 * itself.
 */

const OSC = "Osc" + "ar";
const NEEDLES = [new RegExp(OSC), new RegExp(`${OSC} Co`)];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCOPES = [join(ROOT, "apps"), join(ROOT, "packages", "ui")];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  ".git",
  ".vite",
]);
const SCAN = /\.(ts|tsx|js|jsx|mjs|cjs|html|css)$/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(join(dir, entry.name));
    } else if (SCAN.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

describe("AC-1 no hardcoded identity strings", () => {
  it("no hardcoded name/company remains in apps/* or packages/ui", () => {
    const hits: string[] = [];
    for (const scope of SCOPES) {
      for (const file of walk(scope)) {
        const text = readFileSync(file, "utf8");
        for (const needle of NEEDLES) {
          if (needle.test(text)) {
            hits.push(relative(ROOT, file));
            break;
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
