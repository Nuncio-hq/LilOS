import { LILOS_TOOLS } from "@lilos/contracts/harness";
import { describe, expect, it } from "vitest";
import { approvals } from "../src/guide/approvals.js";
import { employees } from "../src/guide/employees.js";

function approvalNames(): string[] {
  return Object.entries(LILOS_TOOLS)
    .filter(([, tool]) => tool.access === "approval")
    .map(([name]) => name);
}

/**
 * Issue #783: the approvals and employees guide pages hand-wrote tool
 * facts. The approvals page dropped the schedule approval tools. The
 * employees page said the approval gate ships separately. This fails
 * when an approval tool is missing from either page, or when the
 * employees page still claims the gate is unshipped.
 */
describe("approvals guide page lists every approval tool (#783)", () => {
  const body = approvals.body;

  it("names every catalog approval tool as opening an approval ask", () => {
    const names = approvalNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(body, name).toContain(`\`${name}\` (opens an approval ask)`);
    }
  });
});

describe("employees guide page matches the shipped approval gate (#783)", () => {
  const body = employees.body;

  it("does not claim the approval gate ships separately", () => {
    expect(body).not.toMatch(/ships separately/i);
  });

  it("names every catalog approval tool as opening an approval ask", () => {
    const names = approvalNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(body, name).toContain(`\`${name}\` (opens an approval ask)`);
    }
  });
});
