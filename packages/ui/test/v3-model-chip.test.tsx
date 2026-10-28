// @vitest-environment happy-dom
/* The composer's model chip for a runtime agent (#886 + #872): until its own
   catalog lands (#890) it keeps a chip — the runtime's own model labels as
   a menu, or the agent's own model read-only when the runtime lists none —
   and never shows the default engine's list. */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { V3Data } from "../src/v3/v3-data-types";
import { folderHint, ModelChip } from "../src/v3/v3-draft-chips";
import type { V3Actions } from "../src/v3/v3-page-types";
import type { V3Agent } from "../src/v3/v3-types";

afterEach(cleanup);

const data = (models?: string[]) =>
  ({
    modelChoices: ["Opus 5.5", "Sonnet 5.5"],
    runtimes: [
      { id: "hermes", label: "Hermes", isDefault: true },
      { id: "acp:devin", label: "Devin", models },
    ],
  }) as unknown as V3Data;

const chip = (d: V3Data, runtime: string | undefined, label: string) =>
  render(
    <ModelChip
      data={d}
      act={{} as V3Actions}
      agent={{ runtime } as V3Agent}
      onPick={vi.fn()}
      label={label}
      onLabel={vi.fn()}
      open={false}
      onOpen={vi.fn()}
    />,
  ).container;

describe("ModelChip without a landed catalog", () => {
  test("a runtime with its own models menus those, never the default list", async () => {
    const c = chip(data(["SWE-2", "SWE-2 Max"]), "acp:devin", "SWE-2");
    const btn = c.querySelector('button[aria-haspopup="menu"]');
    expect(btn?.textContent).toContain("SWE-2");
    await act(async () => fireEvent.click(btn as HTMLElement));
    expect(c.textContent).toContain("SWE-2 Max");
    expect(c.textContent).not.toContain("Opus 5.5");
  });

  test("a runtime that lists no models keeps a read-only chip with the agent's own", () => {
    const c = chip(data(undefined), "acp:devin", "SWE-2");
    const el = c.querySelector('[data-slot="model-chip-static"]');
    expect(el?.textContent).toContain("SWE-2");
    expect(el?.getAttribute("title")).toContain("Devin");
    expect(c.querySelector("button")).toBeNull();
  });

  test("the agent's own model is on the menu even when the runtime omits it", async () => {
    const c = chip(data(["SWE-2 Max"]), "acp:devin", "SWE-2");
    await act(async () =>
      fireEvent.click(c.querySelector("button") as HTMLElement),
    );
    expect(
      [...c.querySelectorAll('[role="menuitemradio"]')].map(
        (e) => e.textContent,
      ),
    ).toEqual(["SWE-2", "SWE-2 Max"]);
  });

  test("the default engine's agent still menus the engine's choices", async () => {
    const c = chip(data(), "hermes", "Opus 5.5");
    await act(async () =>
      fireEvent.click(c.querySelector("button") as HTMLElement),
    );
    expect(c.textContent).toContain("Sonnet 5.5");
  });

  test("no runtime models and no label: no chip", () => {
    expect(chip(data(undefined), "acp:devin", "").children).toHaveLength(0);
  });
});

/* #899: while the screen's own catalog ask is in flight the chip reads
   "Loading models…"; a refused ask reads "Models unavailable" and clicking
   retries — never "Engine default", never the runtime's pinned label. */
describe("ModelChip while its own catalog ask is in flight", () => {
  const dataWithState = (state: "loading" | "failed", detail?: string) =>
    ({
      modelChoices: ["Opus 5.5"],
      runtimes: [
        { id: "hermes", label: "Hermes", isDefault: true },
        {
          id: "acp:devin",
          label: "Devin",
          catalogState: state,
          ...(detail ? { catalogDetail: detail } : {}),
        },
      ],
    }) as unknown as V3Data;

  test("loading reads Loading models…, not the agent's model", () => {
    const c = chip(dataWithState("loading"), "acp:devin", "Swe-2-high");
    const el = c.querySelector('[data-slot="model-chip-loading"]');
    expect(el?.textContent).toContain("Loading models…");
    expect(el?.textContent).not.toContain("Swe-2-high");
    expect(el?.textContent).not.toContain("Engine default");
  });

  test("failed reads Models unavailable, names the reason, and retries", () => {
    const retry = vi.fn();
    const c = render(
      <ModelChip
        data={dataWithState("failed", "devin not on PATH")}
        act={{ retryRuntimeCatalog: retry } as V3Actions}
        agent={{ runtime: "acp:devin" } as V3Agent}
        onPick={vi.fn()}
        label="Swe-2-high"
        onLabel={vi.fn()}
        open={false}
        onOpen={vi.fn()}
      />,
    ).container;
    const btn = c.querySelector('[data-slot="model-chip-failed"]');
    expect(btn?.textContent).toContain("Models unavailable");
    expect(btn?.getAttribute("title")).toContain("devin not on PATH");
    expect(c.textContent).not.toContain("Engine default");
    fireEvent.click(btn as HTMLElement);
    expect(retry).toHaveBeenCalledWith("acp:devin");
  });

  test("selecting the agent asks its runtime (openRuntimeScreen)", () => {
    const open = vi.fn();
    render(
      <ModelChip
        data={dataWithState("loading")}
        act={{ openRuntimeScreen: open } as V3Actions}
        agent={{ runtime: "acp:devin" } as V3Agent}
        onPick={vi.fn()}
        label=""
        onLabel={vi.fn()}
        open={false}
        onOpen={vi.fn()}
      />,
    );
    expect(open).toHaveBeenCalledWith("acp:devin");
  });
});

describe("folderHint — the Project chip's tooltip carries the git facts (#886)", () => {
  test("a branch, no git, and unknown", () => {
    expect(folderHint({ branch: "trunk" } as never)).toBe(
      " · edits land on ⎇ trunk",
    );
    expect(folderHint({ branch: null } as never)).toBe(
      " · not a git repo, edits land in the folder",
    );
    expect(folderHint(undefined)).toBe("");
  });
});
