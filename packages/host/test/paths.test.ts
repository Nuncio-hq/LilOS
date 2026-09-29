import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collapsePath, expandPath, resolveUnderHome } from "../src/paths";

/* `resolveUnderHome` (#238): the boundary `folders.browse`/`folders.add`
   enforce for device peers — only paths that realpath under the Mac user's
   home resolve; `..`, absolute paths outside home, symlink hops out and
   dot-dir segments are all refused. Tests run against a tmpdir "home" so
   nothing touches the real user's folders. */

const made: string[] = [];
const mkhome = () => {
  // realpath: macOS tmpdir is a /var → /private/var alias.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lilos-home-")));
  made.push(dir);
  return dir;
};
const mkoutside = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lilos-outside-")));
  made.push(dir);
  return dir;
};

afterEach(async () => {
  const { rmSync } = await import("node:fs");
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("AC-4 home-folder boundary — resolveUnderHome (#238)", () => {
  it("resolves `~`, `~/x` and absolute paths under home", () => {
    const home = mkhome();
    mkdirSync(join(home, "repos", "crew"), { recursive: true });
    const realHome = realpathSync(home);
    expect(resolveUnderHome("~", home)).toBe(realHome);
    expect(resolveUnderHome("~/repos", home)).toBe(`${realHome}/repos`);
    expect(resolveUnderHome("~/repos/crew", home)).toBe(
      `${realHome}/repos/crew`,
    );
    expect(resolveUnderHome(`${realHome}/repos/crew`, home)).toBe(
      `${realHome}/repos/crew`,
    );
    // relative paths resolve under home like the picker navigates
    expect(resolveUnderHome("repos", home)).toBe(`${realHome}/repos`);
    // a non-existent tail under home still resolves through its parents
    expect(resolveUnderHome("~/repos/new-folder", home)).toBe(
      `${realHome}/repos/new-folder`,
    );
  });

  it("refuses `..` escapes and absolute paths outside home", () => {
    const home = mkhome();
    const outside = mkoutside();
    for (const p of [
      "~/../",
      "~/..",
      "../",
      `~/repos/../../${outside.slice(1)}`,
      "/",
      "/etc",
      "/System",
      outside,
      `${outside}/x`,
      `${home}/../${outside.split("/").at(-1)}`,
    ]) {
      expect(resolveUnderHome(p, home), p).toBeUndefined();
    }
  });

  it("refuses symlinks that hop outside home, allows inside hops", () => {
    const home = mkhome();
    const outside = mkoutside();
    mkdirSync(join(home, "real"), { recursive: true });
    symlinkSync(outside, join(home, "outlink"));
    symlinkSync(join(home, "real"), join(home, "inlink"));
    expect(resolveUnderHome("~/outlink", home)).toBeUndefined();
    expect(resolveUnderHome("~/outlink/sub", home)).toBeUndefined();
    expect(resolveUnderHome(`${home}/outlink`, home)).toBeUndefined();
    expect(resolveUnderHome("~/inlink", home)).toBe(
      realpathSync(join(home, "real")),
    );
  });

  it("refuses dot-dir segments — hidden folders are not browsable", () => {
    const home = mkhome();
    mkdirSync(join(home, ".ssh"), { recursive: true });
    mkdirSync(join(home, "x", ".lilos"), { recursive: true });
    expect(resolveUnderHome("~/.ssh", home)).toBeUndefined();
    expect(resolveUnderHome("~/x/.lilos", home)).toBeUndefined();
    // …but the home root itself (no segments below it) is fine
    expect(resolveUnderHome("~", home)).toBe(realpathSync(home));
    expect(resolveUnderHome("~/x", home)).toBe(realpathSync(join(home, "x")));
  });

  it("realpaths the home dir itself (macOS /var → /private/var)", () => {
    // Build a home reached through a symlink so `home` is not canonical.
    const base = mkoutside();
    const home = join(base, "home-link");
    symlinkSync(mkoutside(), home);
    mkdirSync(join(realpathSync(home), "x"));
    const abs = resolveUnderHome("~/x", home);
    // The resolved path folds back to `~/x` for the wire even when `home`
    // itself is a symlink (the resolved form is literal-home-prefixed).
    expect(abs).toBe(join(home, "x"));
    if (!abs) throw new Error("~/x refused under a symlinked home");
    expect(collapsePath(abs, home)).toBe("~/x");
  });
});

describe("expandPath/collapsePath with an explicit home (#238)", () => {
  it("round-trips under the given home", () => {
    const home = "/tmp/fake-home";
    expect(expandPath("~", home)).toBe(home);
    expect(expandPath("~/a/b", home)).toBe(`${home}/a/b`);
    expect(expandPath("rel", home)).toBe(`${home}/rel`);
    expect(collapsePath(`${home}/a/b`, home)).toBe("~/a/b");
    expect(collapsePath("/elsewhere", home)).toBe("/elsewhere");
  });
});
