import { LILOS_TOOLS, TOOL_AREAS } from "@lilos/contracts/harness";
import { describe, expect, it } from "vitest";
import { gateway } from "../src/guide/gateway.js";

/**
 * Issue #754: `lilos_guide` topic `gateway` is the catalog an employee
 * reads. A hand-written list dropped every approval tool (#341) and the
 * schedule area (#136). This fails when a tool area or an approval tool
 * is missing from the page again.
 */
describe("gateway guide page lists the catalog (#754)", () => {
  const body = gateway.body;

  it("names every tool area from TOOL_AREAS", () => {
    for (const area of TOOL_AREAS) {
      expect(body, area).toMatch(new RegExp(`^- \`${area}\`:`, "m"));
    }
  });

  it("names every catalog tool", () => {
    for (const name of Object.keys(LILOS_TOOLS)) {
      expect(body, name).toContain(`\`${name}\``);
    }
  });

  it("names the ask lines why, ifYes and ifNo", () => {
    expect(body).toContain("why");
    expect(body).toContain("ifYes");
    expect(body).toContain("ifNo");
  });

  it("names every approval tool as opening an approval ask", () => {
    const approvals = Object.entries(LILOS_TOOLS)
      .filter(([, tool]) => tool.access === "approval")
      .map(([name]) => name);
    expect(approvals.length).toBeGreaterThan(0);
    for (const name of approvals) {
      expect(body, name).toContain(`\`${name}\` (opens an approval ask)`);
    }
  });
});
