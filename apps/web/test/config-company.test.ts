/* D-#836: the company layer pauses behind `features.company === false`; the
   only ways back are `?company=1` on the tab (it rides the search the hash
   nav leaves alone) or a stack booted LILOS_COMPANY=1, whose
   /lilos-config.json says `company: true`. Nothing else turns it on. */
import { describe, expect, test } from "vitest";
import { companyLayerOn } from "../src/lib/config";

describe("companyLayerOn (D-#836)", () => {
  test("paused is the default: no param, no config flag", () => {
    expect(companyLayerOn("")).toBe(false);
    expect(companyLayerOn("?page=threads")).toBe(false);
    expect(companyLayerOn("", {})).toBe(false);
    expect(companyLayerOn("", { company: false })).toBe(false);
  });

  test("the served config's `company: true` shows the layer", () => {
    expect(companyLayerOn("", { company: true })).toBe(true);
    expect(companyLayerOn("?statusPollMs=500", { company: true })).toBe(true);
  });

  test("`?company=1` shows the layer, alone or beside other params", () => {
    expect(companyLayerOn("?company=1")).toBe(true);
    expect(companyLayerOn("?statusPollMs=500&company=1")).toBe(true);
    // Only the exact opt-in counts — anything else stays paused.
    expect(companyLayerOn("?company=0")).toBe(false);
    expect(companyLayerOn("?company=true")).toBe(false);
  });

  test("the URL hatch works even where the config endpoint cannot reach", () => {
    // The desktop window's config is the preload's; `?company=1` is how a
    // spec asks it for the layer (ac-80's org-chart leg).
    expect(companyLayerOn("?company=1", { company: false })).toBe(true);
    expect(companyLayerOn("?company=1", {})).toBe(true);
  });
});
