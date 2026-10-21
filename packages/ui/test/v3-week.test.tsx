// @vitest-environment happy-dom
/* This week's stuck count is drawn like failed: the number is always on an
   agent's page, the word only when it is above zero on People, and the
   colour only then. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { AgentWeek } from "../src/v3/v3-agent-week";
import type { V3Data } from "../src/v3/v3-data-types";
import type { V3Actions } from "../src/v3/v3-page-types";
import { V3People } from "../src/v3/v3-people";
import type { V3Agent } from "../src/v3/v3-types";

afterEach(cleanup);

const agent = (weekThreads: V3Agent["weekThreads"]): V3Agent =>
  ({
    id: "ada",
    name: "Ada",
    tone: "c",
    role: "Researcher",
    hired: "1 Jan",
    model: "m",
    instructions: [],
    weekThreads,
  }) as V3Agent;

const data = (a: V3Agent): V3Data =>
  ({
    me: "Nia",
    company: "Nia",
    today: "Wednesday",
    agents: [a],
    threads: [],
    tickets: [],
    connectors: [],
    projects: [],
    goals: [],
    asks: [],
    updates: [],
    schedules: [],
    hireTemplates: [],
    modelChoices: [],
    browser: { tabs: [], bookmarks: [] },
    devices: [],
  }) as unknown as V3Data;

const statValue = (label: string) =>
  screen.getByText(label).previousElementSibling;

describe("this week's stuck count", () => {
  test("zero is shown on the agent page and takes no colour", () => {
    render(
      <AgentWeek
        data={data(agent({ finished: 1, failed: 0, stuck: 0 }))}
        go={() => {}}
        agent={agent({ finished: 1, failed: 0, stuck: 0 })}
        tickets={[]}
      />,
    );
    const stuck = statValue("threads stuck");
    const failed = statValue("threads failed");
    expect(stuck?.textContent).toBe("0");
    expect(failed?.textContent).toBe("0");
    expect(stuck?.className).not.toMatch(/text-red-/);
    expect(failed?.className).not.toMatch(/text-red-/);
  });

  test("a count above zero is coloured, on the agent page and on People", () => {
    const a = agent({ finished: 2, failed: 1, stuck: 3 });
    render(<AgentWeek data={data(a)} go={() => {}} agent={a} tickets={[]} />);
    expect(statValue("threads stuck")?.className).toMatch(/text-red-600/);
    expect(statValue("threads failed")?.className).toMatch(/text-red-600/);
    cleanup();

    render(
      <V3People
        data={data(a)}
        go={() => {}}
        act={{} as V3Actions}
        view="table"
      />,
    );
    const row = screen.getByRole("button", { name: /Ada/ });
    expect(row.textContent).toContain("2 finished");
    expect(row.textContent).toContain("1 failed");
    expect(row.textContent).toContain("3 stuck");
    expect(row.textContent).not.toContain("0 stuck");
    const stuck = screen.getByText("3 stuck");
    const failed = screen.getByText("1 failed");
    expect(stuck.className).toMatch(/text-red-600/);
    expect(failed.className).toMatch(/text-red-600/);
  });

  test("People omits a zero stuck count", () => {
    const a = agent({ finished: 1, failed: 0, stuck: 0 });
    render(
      <V3People
        data={data(a)}
        go={() => {}}
        act={{} as V3Actions}
        view="table"
      />,
    );
    const row = screen.getByRole("button", { name: /Ada/ });
    expect(row.textContent).toContain("1 finished");
    expect(row.textContent).not.toMatch(/failed/);
    expect(row.textContent).not.toMatch(/stuck/);
  });
});
