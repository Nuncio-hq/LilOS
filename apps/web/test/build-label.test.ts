/**
 * Issue #141 — AC-1/AC-3: the sidebar "dev · fake engine" label follows the
 * engine the harness actually runs (system.status's engine name), never the
 * build identity. An ad-hoc Hermes bundle must be indistinguishable from a
 * release in this one respect; a fake-engine dev build stays labeled.
 */

import { describe, expect, it } from "vitest";
import { buildLabel } from "../src/lib/build-label";

describe("AC-3 (#141) a build running engine-fake is labeled", () => {
  it("labels dev · fake engine", () => {
    expect(buildLabel("engine-fake")).toBe("dev · fake engine");
  });
});

describe("AC-1 (#141) an ad-hoc Hermes build shows no fake-engine label", () => {
  it("engine-hermes has no label", () => {
    expect(buildLabel("engine-hermes")).toBeUndefined();
  });

  it("a missing or other engine name has no label either", () => {
    expect(buildLabel(undefined)).toBeUndefined();
    expect(buildLabel("hermes")).toBeUndefined();
  });
});
