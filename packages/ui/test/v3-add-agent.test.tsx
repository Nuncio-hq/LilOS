// @vitest-environment happy-dom
/* Add agent (#870): the small dialog the ＋ beside Agents and the composer
   menu's "Add agent…" both open — Who? (the engine's hirable profiles plus
   each runtime `system.status.runtimes` reports), Name, Hire. The model
   (`hireChoices`) is the roster joined with the runtime report: a profile an
   agent already runs on is never offered, a runtime's own seed profile folds
   into its row, and an unavailable or failed runtime greys instead of
   hiding, with the plain reason it reported. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { hireChoices, V3AddAgent } from "../src/v3/v3-add-agent";
import type { V3Data } from "../src/v3/v3-data-types";
import type { V3Actions } from "../src/v3/v3-page-types";
import type { V3Agent, V3Profile, V3Runtime } from "../src/v3/v3-types";

afterEach(cleanup);

const hiredAgent: V3Agent = {
  id: "emp_1",
  name: "Reviewer",
  tone: "b",
  role: "QA",
  hired: "1 Oct",
  profile: "reviewer",
  model: "Sonnet 5",
  instructions: [],
};

const profiles: V3Profile[] = [
  { id: "reviewer", name: "Reviewer", skills: 2 },
  {
    id: "ops",
    name: "Ops",
    description: "Runs the nightly chores.",
    skills: 14,
  },
  /* A coding runtime's roster seed — stamped with the runtime it belongs
     to, so it folds into that row rather than listing as a profile. */
  {
    id: "devin",
    name: "Devin",
    description: "Devin CLI over ACP.",
    skills: 0,
    runtime: "acp:devin",
  },
];

const runtimes: V3Runtime[] = [
  { id: "hermes", label: "Hermes", available: true, isDefault: true },
  { id: "acp:devin", label: "Devin", available: true },
  {
    id: "acp:cursor",
    label: "Cursor",
    available: false,
    detail: "cursor-agent is not on PATH",
  },
];

const data = (over: Partial<V3Data> = {}): V3Data =>
  ({
    company: "Co",
    me: "Me",
    today: "Monday",
    agents: [hiredAgent],
    runtimes,
    ...over,
  }) as V3Data;

const actions = (over: Partial<V3Actions> = {}): V3Actions =>
  ({
    listProfiles: vi.fn(async () => profiles),
    hire: vi.fn(async () => "emp_new"),
    hireProfile: vi.fn(async () => "emp_new"),
    updateAgent: vi.fn(async () => undefined),
    ...over,
  }) as unknown as V3Actions;

/** The Who? row whose label holds `text`; missing is a spec bug. */
const row = (text: string) => {
  const r = screen
    .getAllByRole("radio")
    .find((el) => el.textContent?.includes(text));
  if (!r) throw new Error(`no Who? row for ${text}`);
  return r;
};

const mount = (act_: V3Actions, d = data(), onHired = vi.fn()) => {
  const onClose = vi.fn();
  render(
    <V3AddAgent data={d} act={act_} onHired={onHired} onClose={onClose} />,
  );
  return { onClose, onHired };
};

describe("hireChoices", () => {
  test("a profile an agent already runs on is never offered", () => {
    const keys = hireChoices({
      profiles,
      runtimes,
      agents: [hiredAgent],
    }).map((c) => c.key);
    expect(keys).not.toContain("p:reviewer");
    expect(keys).toContain("p:ops");
  });

  test("the default runtime is not itself a row; its profiles are", () => {
    const choices = hireChoices({ profiles, runtimes, agents: [] });
    expect(choices.some((c) => c.key === "r:hermes")).toBe(false);
    expect(choices.some((c) => c.key === "p:ops")).toBe(true);
  });

  test("a runtime's seed profile folds into its row and never lists twice", () => {
    const choices = hireChoices({ profiles, runtimes, agents: [] });
    const devin = choices.find((c) => c.key === "r:acp:devin");
    expect(choices.some((c) => c.key === "p:devin")).toBe(false);
    expect(devin).toMatchObject({
      name: "Devin",
      profile: "devin",
      runtime: "acp:devin",
    });
    expect(devin?.unavailable).toBeUndefined();
  });

  test("an unavailable runtime greys with its own reason", () => {
    const cursor = hireChoices({ profiles, runtimes, agents: [] }).find(
      (c) => c.key === "r:acp:cursor",
    );
    expect(cursor?.unavailable).toBe("cursor-agent is not on PATH");
  });

  test("a failed runtime greys even when the probe once passed", () => {
    const failed = hireChoices({
      profiles,
      runtimes: [
        runtimes[0] ?? { id: "hermes", label: "Hermes", isDefault: true },
        {
          id: "acp:devin",
          label: "Devin",
          available: true,
          state: "failed",
          detail: "exited during handshake",
        },
      ],
      agents: [],
    }).find((c) => c.key === "r:acp:devin");
    expect(failed?.unavailable).toBe("exited during handshake");
  });

  test("a runtime whose seed is already hired still lists — a fresh profile", () => {
    const devin = hireChoices({
      profiles,
      runtimes,
      agents: [{ ...hiredAgent, profile: "devin" }],
    }).find((c) => c.key === "r:acp:devin");
    expect(devin).toMatchObject({ name: "Devin", runtime: "acp:devin" });
    expect(devin?.profile).toBeUndefined();
  });

  test("a runtime with no seed takes its label as the suggested name", () => {
    const cursorless = hireChoices({
      profiles: [],
      runtimes: [
        runtimes[0] ?? { id: "hermes", label: "Hermes", isDefault: true },
        { id: "acp:antigravity", label: "Antigravity" },
      ],
      agents: [],
    }).find((c) => c.key === "r:acp:antigravity");
    expect(cursorless?.name).toBe("Antigravity");
  });

  test("no runtime report at all: profiles only, nothing invented", () => {
    const keys = hireChoices({ profiles, agents: [] }).map((c) => c.key);
    expect(keys).toEqual(["p:reviewer", "p:ops", "p:devin"]);
    /* The seed's stamp still rides along — a hire onto it lands on the
       runtime that listed it even when no status row names the runtime. */
    expect(
      hireChoices({ profiles, agents: [] }).find((c) => c.key === "p:devin")
        ?.runtime,
    ).toBe("acp:devin");
  });
});

describe("the dialog", () => {
  test("Who? lists profiles and runtimes; Name starts as the first pick", async () => {
    mount(actions());
    const group = await screen.findByRole("radiogroup", { name: "Who?" });
    await act(async () => {});
    expect(group.textContent).toContain("Ops");
    expect(group.textContent).toContain("Devin");
    expect(group.textContent).toContain("Cursor");
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Ops");
  });

  test("a greyed row shows the reason and cannot be picked", async () => {
    mount(actions());
    await screen.findByRole("radiogroup", { name: "Who?" });
    await act(async () => {});
    const cursor = row("Cursor");
    expect(cursor.textContent).toContain("cursor-agent is not on PATH");
    fireEvent.click(cursor);
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Ops");
  });

  test("a typed name stays when the pick changes", async () => {
    mount(actions());
    await screen.findByRole("radiogroup", { name: "Who?" });
    await act(async () => {});
    const box = screen.getByLabelText("Name");
    fireEvent.change(box, { target: { value: "Rex" } });
    fireEvent.click(row("Devin"));
    expect(box).toHaveProperty("value", "Rex");
  });

  test("Hire on a profile links it; Hire on a runtime creates fresh there", async () => {
    const act_ = actions();
    const onHired = vi.fn();
    mount(act_, data(), onHired);
    await screen.findByRole("radiogroup", { name: "Who?" });
    await act(async () => {});
    // First pick: the free Hermes profile, linked by id.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Hire" }));
    });
    expect(act_.hireProfile).toHaveBeenCalledWith({
      profile: "ops",
      name: "Ops",
      role: "Runs the nightly chores.",
      runtime: undefined,
    });
    expect(onHired).toHaveBeenCalledWith("emp_new");
  });

  test("Hire on a runtime row lands the hire on that runtime", async () => {
    const act_ = actions();
    const onHired = vi.fn();
    mount(act_, data(), onHired);
    await screen.findByRole("radiogroup", { name: "Who?" });
    await act(async () => {});
    fireEvent.click(row("Devin"));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Devin Two" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Hire" }));
    });
    /* The runtime's seed profile links: the agent hired lands on acp:devin
       running the seed it listed. */
    expect(act_.hireProfile).toHaveBeenCalledWith({
      profile: "devin",
      name: "Devin Two",
      role: "Devin CLI over ACP.",
      runtime: "acp:devin",
    });
    expect(onHired).toHaveBeenCalledWith("emp_new");
  });

  test("a roster refetch keeps the picked row, even if the list moved", async () => {
    /* The shell rebuilds `act` on every data emit, which refires the
       profiles fetch — the selection is keyed, not indexed, so a new row
       ahead of the pick cannot steal it. */
    let list = profiles;
    const act_ = actions({ listProfiles: vi.fn(async () => list) });
    const onClose = vi.fn();
    const { rerender } = render(
      <V3AddAgent
        data={data()}
        act={act_}
        onHired={vi.fn()}
        onClose={onClose}
      />,
    );
    await screen.findByRole("radiogroup", { name: "Who?" });
    await act(async () => {});
    fireEvent.click(row("Devin"));
    list = [{ id: "newbie", name: "Newbie", skills: 0 }, ...profiles];
    rerender(
      <V3AddAgent
        data={data()}
        act={{ ...act_ }}
        onHired={vi.fn()}
        onClose={onClose}
      />,
    );
    await act(async () => {});
    expect(row("Devin").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Devin");
  });

  test("while the roster loads, Hire waits — a runtime row would miss its seed", async () => {
    const act_ = actions({
      listProfiles: vi.fn(() => new Promise<V3Profile[]>(() => {})),
    });
    mount(act_);
    await screen.findByRole("radiogroup", { name: "Who?" });
    // Runtime rows are already listed (they come from data, not the fetch).
    fireEvent.click(row("Devin"));
    expect(screen.getByRole("button", { name: "Hire" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  test("a runtime with no seed hires fresh on it", async () => {
    const act_ = actions();
    mount(
      act_,
      data({
        runtimes: [
          runtimes[0] ?? { id: "hermes", label: "Hermes", isDefault: true },
          { id: "acp:windsurf", label: "Windsurf" },
        ],
      }),
    );
    await screen.findByRole("radiogroup", { name: "Who?" });
    await act(async () => {});
    fireEvent.click(row("Windsurf"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Hire" }));
    });
    expect(act_.hire).toHaveBeenCalledWith({
      name: "Windsurf",
      role: "",
      model: "",
      runtime: "acp:windsurf",
    });
  });

  test("an empty name cannot hire; Esc closes only the dialog", async () => {
    const act_ = actions();
    const { onClose } = mount(act_);
    await screen.findByRole("radiogroup", { name: "Who?" });
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "" } });
    const hire = screen.getByRole("button", { name: "Hire" });
    fireEvent.click(hire);
    expect(act_.hireProfile).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(act_.hire).not.toHaveBeenCalled();
  });
});
