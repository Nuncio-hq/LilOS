// @vitest-environment happy-dom
/* A cycle is drawn once. Someone who reports into it, and who comes first
   in the roster, is not a second root. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { V3Data } from "../src/v3/v3-data-types";
import { OrgChart } from "../src/v3/v3-org";
import type { V3Agent } from "../src/v3/v3-types";

afterEach(cleanup);

const agent = (id: string, reportsTo?: string): V3Agent =>
  ({
    id,
    name: id,
    tone: "c",
    role: "role",
    hired: "1 Jan",
    model: "m",
    instructions: [],
    ...(reportsTo ? { reportsTo } : {}),
  }) as V3Agent;

const data = (agents: V3Agent[]): V3Data =>
  ({
    me: "Nia",
    agents,
    threads: [],
    tickets: [],
    hireTemplates: [],
  }) as unknown as V3Data;

describe("org chart cycles", () => {
  test("A→B, B↔C, roster [A, B, C]: each agent is drawn once, under the cycle", () => {
    render(
      <OrgChart
        data={data([agent("A", "B"), agent("B", "C"), agent("C", "B")])}
        go={() => {}}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3);
    const reports = (name: RegExp) =>
      screen.getByRole("button", { name }).getAttribute("data-reports-to");
    expect(reports(/^A/)).toBe("B");
    expect(reports(/^B/)).toBe("owner");
    expect(reports(/^C/)).toBe("B");
    expect(screen.queryByRole("button", { name: /Hire an agent/ })).toBeNull();
  });
});
