// @vitest-environment happy-dom
/* Three first-run and sidebar gaps the old app covered:
   - an agent's sidebar dot is its most urgent thread's status, and a finish
     you have not seen shows on it (D-#563);
   - the Hire page lists the engine's own profiles as a quiet second section
     and hires one onto the profile (capability by presence);
   - first run keeps a strip the window can be dragged by, and the problem
     screen (in place of the steps while something is down, #885) offers
     "See status" only where the app has a status view. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { V3AgentPage } from "../src/v3/v3-agent";
import type { V3Data } from "../src/v3/v3-data-types";
import { V3Hire } from "../src/v3/v3-hire";
import { agentDot } from "../src/v3/v3-model";
import type { V3Actions, V3Nav } from "../src/v3/v3-page-types";
import { V3Shell } from "../src/v3/v3-shell";
import type {
  V3Agent,
  V3Profile,
  V3Status,
  V3Thread,
} from "../src/v3/v3-types";
import { V3Welcome } from "../src/v3/v3-welcome";
import { EngineProblem, firstRunProblem } from "../src/v3/v3-welcome-engine";

afterEach(cleanup);

const agent: V3Agent = {
  id: "emp_1",
  name: "Reviewer",
  tone: "b",
  role: "QA",
  hired: "1 Oct",
  profile: "reviewer",
  model: "Sonnet 5",
  instructions: [],
};

const thread = (
  id: string,
  status: V3Status,
  over: Partial<V3Thread> = {},
): V3Thread => ({
  id,
  agentId: "emp_1",
  title: id,
  status,
  startedAt: "10:00",
  minutes: 3,
  step: 1,
  context: 1,
  folder: "~",
  changes: [],
  turns: [],
  ...over,
});

const data = (over: Partial<V3Data> = {}): V3Data =>
  ({
    company: "Co",
    me: "Me",
    today: "Monday",
    agents: [agent],
    connectors: [],
    projects: [],
    goals: [],
    tickets: [],
    threads: [],
    asks: [],
    updates: [],
    schedules: [],
    browser: { tabs: [], bookmarks: [] },
    devices: [],
    modelChoices: ["Sonnet 5"],
    settings: {
      engine: { state: "down", name: "Hermes" },
      relay: { state: "ok" },
    },
    setUp: true,
    features: { tickets: false },
    ...over,
  }) as unknown as V3Data;

const withThreads = (...threads: V3Thread[]) => data({ threads });

describe("an agent's dot (needs > working > failed > unseen > idle)", () => {
  test("no threads, or only seen ones: idle", () => {
    expect(agentDot(withThreads(), "emp_1")).toBe("idle");
    expect(agentDot(withThreads(thread("a", "done")), "emp_1")).toBe("idle");
  });

  test("a finish you have not seen shows as its own status", () => {
    expect(
      agentDot(withThreads(thread("a", "done", { unseen: true })), "emp_1"),
    ).toBe("done");
  });

  test("a more urgent thread outranks the unseen one", () => {
    const unseen = thread("u", "done", { unseen: true });
    const dot = (s: V3Status) =>
      agentDot(withThreads(unseen, thread("x", s)), "emp_1");
    expect(dot("failed")).toBe("failed");
    expect(dot("working")).toBe("working");
    expect(dot("needs")).toBe("needs");
    // …and a seen finish never hides one that is not seen.
    expect(
      agentDot(
        withThreads(thread("s", "done"), thread("u", "done", { unseen: true })),
        "emp_1",
      ),
    ).toBe("done");
  });

  test("only its own threads count", () => {
    expect(
      agentDot(
        withThreads(thread("o", "needs", { agentId: "someone-else" })),
        "emp_1",
      ),
    ).toBe("idle");
  });
});

const actions = (over: Partial<V3Actions> = {}): V3Actions =>
  ({ ask: vi.fn(), ...over }) as unknown as V3Actions;

const PROFILES: V3Profile[] = [
  { id: "reviewer", name: "Reviewer", skills: 6 },
  {
    id: "ops",
    name: "Ops",
    description: "Runs the chores",
    model: "Haiku 5",
    skills: 14,
    soul: "You keep the dev server healthy.",
  },
];

describe("hire from an existing profile", () => {
  test("lists only profiles nobody runs on, and hires the picked one", async () => {
    const go = vi.fn();
    const hireProfile = vi.fn(async () => "emp_2");
    render(
      <V3Hire
        data={data()}
        go={go}
        act={actions({
          hire: vi.fn(),
          listProfiles: async () => PROFILES,
          hireProfile,
        })}
      />,
    );
    const section = await screen.findByRole("region", {
      name: "Existing engine profiles",
    });
    expect(
      within(section).getByText("Or bring in an existing profile"),
    ).toBeTruthy();
    // `reviewer` already has an agent: not offered a second time.
    expect(
      within(section).queryByRole("button", { name: /Reviewer/ }),
    ).toBeNull();
    fireEvent.click(within(section).getByRole("button", { name: /Ops/ }));
    // The form starts from the engine's words and shows what it keeps owning.
    expect(
      (screen.getByPlaceholderText("Name") as HTMLInputElement).value,
    ).toBe("Ops");
    expect(within(section).getByText("Haiku 5")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Name"), {
      target: { value: "Operator" },
    });
    // A second click while the first is in flight hires once.
    const hire = screen.getByRole("button", { name: "Hire" });
    fireEvent.click(hire);
    fireEvent.click(hire);
    await waitFor(() => expect(go).toHaveBeenCalledTimes(2));
    expect(hireProfile).toHaveBeenCalledTimes(1);
    expect(hireProfile).toHaveBeenCalledWith({
      profile: "ops",
      name: "Operator",
      role: "Runs the chores",
    });
    expect(go).toHaveBeenLastCalledWith({ page: "agent", id: "emp_2" });
  });

  test("no listProfiles or hireProfile: no second section", async () => {
    for (const missing of ["listProfiles", "hireProfile"] as const) {
      const base = {
        hire: vi.fn(),
        listProfiles: async () => PROFILES,
        hireProfile: vi.fn(),
      };
      const { unmount } = render(
        <V3Hire
          data={data({ agents: [] })}
          go={vi.fn()}
          act={actions({ ...base, [missing]: undefined })}
        />,
      );
      await act(async () => {});
      expect(screen.queryByText("Or bring in an existing profile")).toBeNull();
      unmount();
    }
  });

  test("the agent's page says which engine profile it runs", () => {
    render(
      <V3AgentPage data={data()} go={vi.fn()} act={actions()} id="emp_1" />,
    );
    expect(screen.getByText("Profile")).toBeTruthy();
    expect(screen.getByText("reviewer")).toBeTruthy();
  });

  test("an agent with no known profile has no Profile row", () => {
    render(
      <V3AgentPage
        data={data({ agents: [{ ...agent, profile: undefined }] })}
        go={vi.fn()}
        act={actions()}
        id="emp_1"
      />,
    );
    expect(screen.queryByText("Profile")).toBeNull();
  });
});

describe("first run", () => {
  const welcome = (): V3Nav => ({ page: { page: "welcome" }, peek: [] });

  test("Welcome keeps a drag strip above the page", () => {
    const { container } = render(
      <V3Shell
        data={data({ setUp: false })}
        actions={actions() as never}
        nav={welcome()}
        onNav={vi.fn()}
      />,
    );
    const strip = container.querySelector(".lilos-drag");
    expect(strip).toBeTruthy();
    // The page is below it, not inside it: no control sits under the drag.
    expect(strip?.querySelector("button, input, a")).toBeNull();
    expect(strip?.nextElementSibling?.textContent).toContain(
      "Welcome to LilOS",
    );
  });

  test("the problem screen offers See status only with a status view", () => {
    const shown = vi.fn();
    const { unmount } = render(
      <EngineProblem data={data()} act={actions({ showStatus: shown })} />,
    );
    expect(firstRunProblem(data())).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "See status" }));
    expect(shown).toHaveBeenCalledTimes(1);
    unmount();

    render(<EngineProblem data={data()} act={actions()} />);
    expect(screen.queryByRole("button", { name: "See status" })).toBeNull();
  });

  test("a down relay shows the plain mapping, never the part's own name (#885)", () => {
    /* The status rules' real output for an unreachable relay — "Start the
       relay…" — must not reach the screen; See status keeps the raw text. */
    const down = data({
      settings: {
        engine: { state: "starting", name: "Hermes" },
        relay: {
          state: "down",
          problem:
            "Relay unreachable.\nStart the relay on this Mac, then reopen LilOS.",
        },
      },
    } as never);
    expect(firstRunProblem(down)).toBe(true);
    const { container } = render(<EngineProblem data={down} act={actions()} />);
    expect(
      screen.getByText(/LilOS's background service isn't running/),
    ).toBeTruthy();
    expect(
      container.querySelector("[data-first-run-problem]")?.textContent,
    ).not.toMatch(/relay/i);
  });

  test("a down harness leg, or a start that stalls, is the problem (#885)", () => {
    const downHarness = data({
      settings: {
        engine: { state: "starting", name: "Hermes" },
        harness: { state: "down" },
        relay: { state: "ok" },
      },
    } as never);
    expect(firstRunProblem(downHarness)).toBe(true);
    const { unmount } = render(
      <EngineProblem data={downHarness} act={actions()} />,
    );
    expect(screen.getByText(/starts the engine isn't answering/)).toBeTruthy();
    unmount();

    const stuckHarness = data({
      settings: {
        engine: { state: "starting", name: "Hermes", stuck: "harness" },
        relay: { state: "ok" },
      },
    } as never);
    expect(firstRunProblem(stuckHarness)).toBe(true);

    const stuckEngine = data({
      settings: {
        engine: { state: "starting", name: "Hermes", stuck: "engine" },
        harness: { state: "ok" },
        relay: { state: "ok" },
      },
    } as never);
    expect(firstRunProblem(stuckEngine)).toBe(true);
    render(<EngineProblem data={stuckEngine} act={actions()} />);
    expect(screen.getByText(/engine hasn't answered yet/)).toBeTruthy();
  });

  test("a slow engine start shows the calm note, no problem screen (#885)", async () => {
    const slow = data({
      settings: {
        engine: { state: "starting", name: "Hermes", slow: true },
        harness: { state: "ok" },
        relay: { state: "ok" },
      },
    } as never);
    expect(firstRunProblem(slow)).toBe(false);
    const { unmount } = render(
      <V3Welcome data={slow} go={vi.fn()} act={actions()} />,
    );
    // To the last step: Start waits as "Starting…" with the note beside.
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Starting…" })).toBeTruthy();
    expect(
      screen.getByText("Still starting — this can take a minute."),
    ).toBeTruthy();
    expect(screen.queryByText(/quit LilOS/i)).toBeNull();
    unmount();

    // Recovery: the engine reports — note and wait clear, Start is live.
    const ok = data({
      settings: {
        engine: { state: "ok", name: "Hermes" },
        harness: { state: "ok" },
        relay: { state: "ok" },
      },
    } as never);
    render(<V3Welcome data={ok} go={vi.fn()} act={actions()} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(
      screen.queryByText("Still starting — this can take a minute."),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Start", exact: true }),
    ).toBeTruthy();
  });

  test("a healthy relay and engine never show the problem screen", () => {
    const ok = data({
      settings: {
        engine: { state: "ok", name: "Hermes" },
        relay: { state: "ok" },
      },
    } as never);
    expect(firstRunProblem(ok)).toBe(false);
    const starting = data({
      settings: {
        engine: { state: "starting", name: "Hermes" },
        relay: { state: "starting" },
      },
    } as never);
    expect(firstRunProblem(starting)).toBe(false);
  });
});
