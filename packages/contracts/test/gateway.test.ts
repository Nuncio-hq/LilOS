import { describe, expect, it } from "vitest";
import { AppMethod } from "../src/app/index.js";
import {
  AGENT_METHOD_TOOLS,
  APPROVAL_GATED_METHODS,
  HOST_POLICY_MARKER,
  HOST_POLICY_MAX_CHARS,
  HOST_POLICY_VERSION,
  knownToolNames,
  LILOS_TOOLS,
  NOT_AGENT_FACING,
  PLANNED_TOOL_NAMES,
  renderHostPolicy,
  TOOL_ACCESS,
  TOOL_AREAS,
  type ToolArea,
  toolsForAreas,
} from "../src/harness/index.js";
import { HOST_METHODS } from "../src/host/index.js";

/**
 * Issue #337, AC-1: `harness/tools.ts` is THE one tool catalog. Every
 * engine-facing surface (MCP tools/list, the `lilos` CLI, the host policy)
 * renders from it, so this test pins its shape: canonical `<area>_<action>`
 * names, a doc line, strict Zod params + a result schema, an `access`
 * level, and an `area`.
 */
describe("AC-1 the one tool catalog", () => {
  it("every tool declares name/area/access/doc and Zod params+result", () => {
    for (const [name, t] of Object.entries(LILOS_TOOLS)) {
      expect(TOOL_AREAS, name).toContain(t.area);
      expect(TOOL_ACCESS, name).toContain(t.access);
      expect(t.doc.length, name).toBeGreaterThan(0);
      expect(t.params, name).toBeDefined();
      expect(t.result, name).toBeDefined();
    }
  });

  it("names are canonical <area>_<action> with no stale app_/previews_ names", () => {
    for (const name of Object.keys(LILOS_TOOLS)) {
      const area = LILOS_TOOLS[name].area;
      if (area === "root") {
        expect(name, name).toMatch(/^[a-z]+$/);
      } else {
        expect(name, name).toMatch(new RegExp(`^${area}_[a-z_]+$`));
      }
      expect(name).not.toMatch(/^(app_|previews_list)/);
    }
    // The AC-1 renames landed.
    expect(LILOS_TOOLS.thread_post).toBeDefined();
    expect(LILOS_TOOLS.thread_read).toBeDefined();
    expect(LILOS_TOOLS.workbench_previews).toBeDefined();
    expect(LILOS_TOOLS.app_post_message).toBeUndefined();
    expect(LILOS_TOOLS.previews_list).toBeUndefined();
  });

  it("toolsForAreas renders only the areas a session has", () => {
    const names = toolsForAreas(new Set(["terminal", "workbench"]));
    expect(names).toContain("terminal_run");
    expect(names).toContain("workbench_previews");
    expect(names).not.toContain("browser_open");
    expect(names).not.toContain("thread_post");
  });
});

/**
 * Issue #337, AC-4: the coverage map is exhaustive — every `AppMethod` and
 * every `HOST_METHODS` entry either maps to an agent-facing tool (shipped or
 * planned under its canonical name) or carries a `NOT_AGENT_FACING` reason.
 * An unclassified method fails here, i.e. fails `bun run verify`.
 */
describe("AC-4 coverage: every app+host method is classified", () => {
  const allApp = AppMethod.options as readonly string[];
  const allHost = Object.keys(HOST_METHODS);

  it("every AppMethod is mapped or has a reason", () => {
    const unclassified = allApp.filter(
      (m) =>
        !(m in AGENT_METHOD_TOOLS) &&
        !(m in APPROVAL_GATED_METHODS) &&
        !(m in NOT_AGENT_FACING),
    );
    expect(unclassified).toEqual([]);
  });

  it("every HOST_METHODS entry is mapped or has a reason", () => {
    const unclassified = allHost.filter(
      (m) =>
        !(m in AGENT_METHOD_TOOLS) &&
        !(m in APPROVAL_GATED_METHODS) &&
        !(m in NOT_AGENT_FACING),
    );
    expect(unclassified).toEqual([]);
  });

  it("classifications name real methods — a rename can't go stale", () => {
    const known = new Set([...allApp, ...allHost]);
    for (const key of [
      ...Object.keys(AGENT_METHOD_TOOLS),
      ...Object.keys(APPROVAL_GATED_METHODS),
      ...Object.keys(NOT_AGENT_FACING),
    ]) {
      expect(known.has(key), `stale key: ${key}`).toBe(true);
    }
  });

  it("mapped tools are catalog names or declared planned names", () => {
    const known = knownToolNames();
    for (const [m, tool] of Object.entries(AGENT_METHOD_TOOLS)) {
      expect(known.has(tool), `${m} -> ${tool}`).toBe(true);
    }
    // Planned names stay canonical <area>_<action> and can't collide.
    const shipped = new Set(Object.keys(LILOS_TOOLS));
    for (const name of PLANNED_TOOL_NAMES) {
      expect(shipped.has(name), `${name} is already shipped`).toBe(false);
      expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it("every NOT_AGENT_FACING entry carries a non-empty reason", () => {
    for (const [m, reason] of Object.entries(NOT_AGENT_FACING)) {
      expect(reason.length, m).toBeGreaterThan(10);
    }
  });
});

/**
 * Issue #337, AC-5: the host policy renders FROM the catalog's areas —
 * versioned, short enough to ride in every engine context, mentioning only
 * attached areas, and stating that company changes go through an approval.
 */
describe("AC-5 host policy renders from the catalog", () => {
  it("is versioned, under the char cap, and states the approval rule", () => {
    const policy = renderHostPolicy(new Set(TOOL_AREAS));
    expect(policy).toContain(HOST_POLICY_MARKER);
    expect(HOST_POLICY_MARKER).toBe(
      `[LilOS host policy v${HOST_POLICY_VERSION}]`,
    );
    expect(policy.length).toBeLessThanOrEqual(HOST_POLICY_MAX_CHARS);
    expect(policy).toMatch(/approval/i);
  });

  it("mentions only the areas the session has attached", () => {
    const noBrowser = renderHostPolicy(new Set(["terminal", "workbench"]));
    expect(noBrowser).not.toMatch(/browser/i);
    expect(noBrowser).toContain("terminal_*");
    expect(noBrowser).toContain("workbench_*");
    expect(noBrowser).not.toContain("thread_");

    const withThread = renderHostPolicy(new Set(["thread"]));
    expect(withThread).toContain("thread_*");
    expect(withThread).not.toContain("terminal_");
  });

  it("mentions every area the session does have", () => {
    const full = renderHostPolicy(
      new Set<ToolArea>(["terminal", "browser", "workbench", "thread"]),
    );
    for (const area of ["terminal_*", "browser_*", "workbench_*", "thread_*"]) {
      expect(full).toContain(area);
    }
  });
});
