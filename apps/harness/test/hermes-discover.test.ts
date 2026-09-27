import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hermesSearchPaths, resolveHermesBin } from "../src/engine/discover";

/**
 * Issue #85 AC-2 — Hermes is found without a shell PATH: a launchd-started
 * harness gets a minimal PATH, so discovery checks the override env, a saved
 * file, the known install locations, then PATH — and says plainly where it
 * looked when nothing turns up.
 */

const home = () => mkdtempSync(join(tmpdir(), "lilos-home-"));
/** exists() backed by a fixed set of paths. */
const existing = (...paths: string[]) => {
  const set = new Set(paths);
  return (p: string) => set.has(p);
};

describe("AC-2 (#85) Hermes discovery", () => {
  it("HERMES_BIN wins over every other location", () => {
    const h = home();
    const bin = resolveHermesBin({
      env: { HERMES_BIN: "/custom/hermes", PATH: "/usr/bin" },
      home: h,
      exists: existing("/custom/hermes", `${h}/.local/bin/hermes`),
    });
    expect(bin).toBe("/custom/hermes");
  });

  it("a saved override in ~/.lilos/hermes-bin beats install locations", () => {
    const h = home();
    mkdirSync(join(h, ".lilos"), { recursive: true });
    writeFileSync(join(h, ".lilos", "hermes-bin"), "/saved/hermes\n");
    const bin = resolveHermesBin({
      env: {},
      home: h,
      exists: existing("/saved/hermes", `${h}/.local/bin/hermes`),
    });
    expect(bin).toBe("/saved/hermes");
  });

  it("~/.local/bin/hermes is found without PATH (the launchd case)", () => {
    const h = home();
    const bin = resolveHermesBin({
      env: { PATH: "/usr/bin:/bin" },
      home: h,
      exists: existing(`${h}/.local/bin/hermes`),
    });
    expect(bin).toBe(`${h}/.local/bin/hermes`);
  });

  it("a PATH hit is the last resort", () => {
    const h = home();
    const bin = resolveHermesBin({
      env: { PATH: "/nada:/opt/bin" },
      home: h,
      exists: existing("/opt/bin/hermes"),
    });
    expect(bin).toBe("/opt/bin/hermes");
  });

  it("an explicit pointer to a missing path names it (no silent fallback)", () => {
    const h = home();
    expect(() =>
      resolveHermesBin({
        env: { HERMES_BIN: "/gone/hermes" },
        home: h,
        exists: () => false,
      }),
    ).toThrow(/^Hermes not found at \/gone\/hermes/);
  });

  it("a saved override pointing nowhere names the file it came from", () => {
    const h = home();
    mkdirSync(join(h, ".lilos"), { recursive: true });
    writeFileSync(join(h, ".lilos", "hermes-bin"), "/gone/hermes");
    expect(() =>
      resolveHermesBin({ env: {}, home: h, exists: () => false }),
    ).toThrow(/Hermes not found at \/gone\/hermes.*hermes-bin/);
  });

  it("nothing found lists every place it looked", () => {
    const h = home();
    expect(() =>
      resolveHermesBin({
        env: { PATH: "/only/bin" },
        home: h,
        exists: () => false,
      }),
    ).toThrow(/Hermes not found — looked in [^\n]*\/only\/bin\/hermes/);
  });
});

describe("AC-2 (#85) the search order itself", () => {
  it("known locations come before PATH and cover the launchd gaps", () => {
    const paths = hermesSearchPaths("/h", "/usr/bin:/bin");
    expect(paths).toContain("/h/.local/bin/hermes");
    expect(paths).toContain("/opt/homebrew/bin/hermes");
    expect(paths).toContain("/usr/local/bin/hermes");
    expect(paths.indexOf("/h/.local/bin/hermes")).toBeLessThan(
      paths.indexOf("/usr/bin/hermes"),
    );
  });
});
