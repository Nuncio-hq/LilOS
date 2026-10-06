import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Issue #611 — every bearer/secret compare on a loopback boundary routes
 * through the ONE shared `equalSecret` (@lilos/contracts/auth): SHA-256
 * digests + `timingSafeEqual`, so a remote caller can't time a matching
 * prefix off a `===`/`!==` early-exit. This is a source-contract test: it
 * pins the helper's single home and every call site — red before the lift,
 * green after. A new auth gate must join SITES and use the helper, never
 * grow a local compare.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/* Every file that compares a credential on a loopback boundary. */
const SITES = [
  "apps/harness/src/host.ts",
  "apps/harness/src/surfaces/server.ts",
  "apps/harness/src/feed.ts",
  "packages/surfaces/src/gateway.ts",
  "apps/relay/src/session/handshake.ts",
  "apps/relay/src/db/drizzle-store.ts",
  "apps/relay/test/memory-store.ts",
];

/* A === / !== on a line that also names a credential-ish operand is a
   suspect compare — secrets never get compared directly. */
const SECRET_OPERAND = /token|credential|secret|authorization|bearer/i;
const suspects = (file: string) =>
  read(file)
    .split("\n")
    .map((line, i) => `${file}:${i + 1}: ${line.trim()}`)
    .filter((line) => /===|!==/.test(line) && SECRET_OPERAND.test(line));

describe("AC-1 one shared constant-time compare", () => {
  it("equalSecret lives once, exported as @lilos/contracts/auth", () => {
    const home = read("packages/contracts/src/auth.ts");
    expect(home).toContain("timingSafeEqual");
    expect(home).toMatch(/export function equalSecret/);
    const pkg = JSON.parse(read("packages/contracts/package.json"));
    expect(pkg.exports["./auth"]).toBe("./src/auth.ts");
  });

  it("apps/relay keeps no local copy (#568's original site)", () => {
    expect(read("apps/relay/src/auth.ts")).not.toContain("timingSafeEqual");
  });

  it.each(SITES)("%s imports the helper from @lilos/contracts/auth", (file) => {
    expect(read(file)).toMatch(
      /import\s*\{[^}]*\bequalSecret\b[^}]*\}\s*from\s*"@lilos\/contracts\/auth"/,
    );
  });

  it.each(SITES)("%s has no === / !== compare on a secret", (file) => {
    expect(suspects(file)).toEqual([]);
  });
});
