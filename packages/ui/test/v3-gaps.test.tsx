// @vitest-environment happy-dom
/* Three first-run and sidebar gaps the old app covered:
   - an agent's sidebar dot is its most urgent thread's status, and a finish
     you have not seen shows on it (D-#563);
   - the Hire page lists the engine's own profiles as a quiet second section
     and hires one onto the profile (capability by presence);
   - first run keeps a strip the window can be dragged by, and a failed engine
     check offers "See status" only where the app has a status view. */
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
import { agentDisplayName, agentDot } from "../src/v3/v3-model";
import type { V3Actions, V3Nav } from "../src/v3/v3-page-types";
import { V3Shell } from "../src/v3/v3-shell";
import type {
  V3Agent,
  V3Profile,
  V3Status,
  V3Thread,
} from "../src/v3/v3-types";
import { EngineStep } from "../src/v3/v3-welcome-engine";

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
    const hire = screen.getByRole("button", { name: "Add" });
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

  /* #872 — internals never render: no Profile row, no "Runs on", no hire
     date, no "Now" — whichever profile the agent runs. */
  test("the agent's page never shows internals", () => {
    render(
      <V3AgentPage data={data()} go={vi.fn()} act={actions()} id="emp_1" />,
    );
    expect(screen.queryByText("Profile")).toBeNull();
    expect(screen.queryByText("reviewer")).toBeNull();
    expect(screen.queryByText("Runs on")).toBeNull();
    expect(screen.queryByText("Now")).toBeNull();
    expect(screen.queryByText(/hired /)).toBeNull();
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

  test("a failed engine check offers See status only with a status view", () => {
    const shown = vi.fn();
    const { unmount } = render(
      <EngineStep data={data()} act={actions({ showStatus: shown })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "See status" }));
    expect(shown).toHaveBeenCalledTimes(1);
    unmount();

    render(<EngineStep data={data()} act={actions()} />);
    expect(screen.queryByRole("button", { name: "See status" })).toBeNull();
  });

  test("a healthy engine check has no See status", () => {
    render(
      <EngineStep
        data={data({
          settings: {
            engine: { state: "ok", name: "Hermes" },
            relay: { state: "ok" },
          },
        } as never)}
        act={actions({ showStatus: vi.fn() })}
      />,
    );
    expect(screen.queryByRole("button", { name: "See status" })).toBeNull();
  });
});

describe("#872 agentDisplayName — the untouched stock agent reads Hermes", () => {
  test("stock seed on the default runtime displays Hermes", () => {
    expect(agentDisplayName({ name: "Default", profile: "default" })).toBe(
      "Hermes",
    );
    expect(
      agentDisplayName({
        name: "Default",
        profile: "default",
        runtime: "hermes",
      }),
    ).toBe("Hermes");
    expect(
      agentDisplayName({
        name: "default",
        profile: "default",
        runtime: null,
      }),
    ).toBe("Hermes");
  });

  test("a name the owner set wins over the display default", () => {
    expect(agentDisplayName({ name: "Ren", profile: "default" })).toBe("Ren");
  });

  test("runtime-owned agents keep their own names", () => {
    expect(
      agentDisplayName({
        name: "Default",
        profile: "default",
        runtime: "acp:devin",
      }),
    ).toBe("Default");
    expect(
      agentDisplayName({
        name: "Devin",
        profile: "devin",
        runtime: "acp:devin",
      }),
    ).toBe("Devin");
    expect(
      agentDisplayName({
        name: "Claude Code",
        profile: "claude",
        runtime: "acp:claude",
      }),
    ).toBe("Claude Code");
  });
});
