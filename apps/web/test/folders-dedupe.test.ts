/* D-#854 round 3: "Found on this Mac" lists recents first, then the
   repo scan — one folder under two spellings (case, symlink, `~` vs
   absolute) must not row twice. The merge dedupes on the host's
   canonical key; a path the canonical call never covered compares
   literally, the old behavior. */

import { describe, expect, test } from "vitest";
import { foundRows } from "../src/lib/folders";

const recent = (path: string, missing = false) => ({ path, missing });

describe("the folder picker's Found list dedupe", () => {
  test("a discovered spelling equal to a recent's canonical key is dropped", () => {
    const recents = [recent("~/Code/lilos-alpha")];
    const scanned = ["~/code/lilos-alpha", "~/repos/lilos-beta"];
    // The host said ~/Code/lilos-alpha and ~/code/lilos-alpha are one dir.
    const keys = {
      "~/Code/lilos-alpha": "k:alpha",
      "~/code/lilos-alpha": "k:alpha",
      "~/repos/lilos-beta": "k:beta",
    };
    expect(foundRows(recents, scanned, keys)).toEqual([
      "~/Code/lilos-alpha",
      "~/repos/lilos-beta",
    ]);
  });

  test("missing recents do not suppress a discovered row", () => {
    const recents = [recent("~/Code/gone", true)];
    expect(foundRows(recents, ["~/Code/gone"], {})).toEqual(["~/Code/gone"]);
  });

  test("without keys the compare is literal — the pre-dedupe behavior", () => {
    const recents = [recent("~/Code/lilos-alpha")];
    const scanned = ["~/code/lilos-alpha"];
    expect(foundRows(recents, scanned, {})).toEqual([
      "~/Code/lilos-alpha",
      "~/code/lilos-alpha",
    ]);
  });
});
