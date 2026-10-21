import { describe, expect, it } from "vitest";
import { reportsOf } from "../src/v3/v3-model";
import type { V3Agent } from "../src/v3/v3-types";

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

describe("reportsOf", () => {
  const team = [agent("ada"), agent("bea", "ada"), agent("cio", "gone")];

  it("an absent or dangling reportsTo hangs off the owner", () => {
    expect(reportsOf(team).map((a) => a.id)).toEqual(["ada", "cio"]);
  });

  it("a reportsTo id hangs off that agent", () => {
    expect(reportsOf(team, "ada").map((a) => a.id)).toEqual(["bea"]);
    expect(reportsOf(team, "bea")).toEqual([]);
  });
});
