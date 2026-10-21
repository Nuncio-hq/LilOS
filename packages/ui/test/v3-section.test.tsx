// @vitest-environment happy-dom
/* A section count of 0 is omitted. The empty line under the heading is
   the message; "Needs you 0" would say nothing twice (D-#769). */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { Section } from "../src/v3/v3-bits";
import type { V3Data } from "../src/v3/v3-data-types";
import type { V3Actions } from "../src/v3/v3-page-types";
import { V3People } from "../src/v3/v3-people";
import type { V3Agent } from "../src/v3/v3-types";

afterEach(cleanup);

describe("section counts", () => {
  test("zero is omitted, a positive count and a worded count stay", () => {
    render(<Section title="Needs you" count={0} />);
    expect(screen.getByRole("heading", { name: "Needs you" })).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
    cleanup();

    render(<Section title="Schedules" count="0" />);
    expect(screen.getByRole("heading", { name: "Schedules" })).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
    cleanup();

    render(<Section title="Needs you" count={2} />);
    expect(screen.getByRole("heading", { name: /Needs you\s*2/ })).toBeTruthy();
    cleanup();

    render(<Section title="Waiting on you" count="3 more" />);
    expect(
      screen.getByRole("heading", { name: /Waiting on you\s*3 more/ }),
    ).toBeTruthy();
  });
});

const person = (over: Partial<V3Agent> = {}): V3Agent =>
  ({
    id: "ada",
    name: "Ada",
    tone: "c",
    role: "Researcher",
    hired: "1 Jan",
    model: "m",
    instructions: [],
    ...over,
  }) as V3Agent;

const company = (agents: V3Agent[]): V3Data =>
  ({
    me: "Nia",
    company: "Nia",
    today: "Wednesday",
    agents,
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

describe("Outside workers", () => {
  const open = () =>
    render(
      <V3People
        data={company([person()])}
        go={() => {}}
        act={{ addConnector() {} } as V3Actions}
        view="table"
      />,
    );

  test("a zero count is omitted above the empty line", () => {
    open();
    const heading = screen.getByRole("heading", { name: /Outside workers/ });
    expect(heading.textContent).toMatch(/Outside workers/);
    expect(heading.textContent).not.toMatch(/\b0\b/);
    expect(heading.textContent).toMatch(/Always-on bots/);
    expect(
      screen.getByText("None yet. Add a connector in Settings."),
    ).toBeTruthy();
  });

  test("a positive count stays beside the note", () => {
    render(
      <V3People
        data={company([
          person(),
          person({ id: "bot", name: "Bot", kind: "outside" }),
        ])}
        go={() => {}}
        act={{ addConnector() {} } as V3Actions}
        view="table"
      />,
    );
    expect(
      screen.getByRole("heading", { name: /Outside workers\s*1/ }),
    ).toBeTruthy();
    expect(
      screen.queryByText("None yet. Add a connector in Settings."),
    ).toBeNull();
  });
});
