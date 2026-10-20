/* What the v3 shell acts on is what it draws, not what the URL says (D-#769):
   the open conversation (its engine feed, read mark and silenced
   notifications) follows the thread the side peek shows, and a model label
   is the picker's own label, so a stored model finds its picker row. */
import type { ModelOption } from "@lilos/contracts/engine";
import type { V3Nav } from "@lilos/ui";
import { beforeEach, describe, expect, test } from "vitest";
import {
  engineDefaultModel,
  engineDefaultProvider,
  engineModels,
  modelVisibility,
} from "../src/lib/runtime";
import { modelLabel, pickFromLabel } from "../src/v3/models";
import { threadOnScreen, visibleNav } from "../src/v3/shown";

const threadThenTicket: V3Nav = {
  page: { page: "threads" },
  peek: [
    { page: "thread", id: "conv1" },
    { page: "ticket", id: "t1" },
  ],
};

describe("threadOnScreen", () => {
  const live = { setUp: true, features: { tickets: false } };

  test("a gated record after a thread is not drawn: the thread stays the open conversation", () => {
    expect(threadOnScreen(threadThenTicket, live)).toBe("conv1");
  });

  test("with tickets on, the ticket on top is what the peek shows, so no thread is open", () => {
    expect(
      threadOnScreen(threadThenTicket, {
        setUp: true,
        features: { tickets: true },
      }),
    ).toBeUndefined();
  });

  test("a thread shows only as the peek's top record", () => {
    expect(
      threadOnScreen(
        {
          page: { page: "threads" },
          peek: [
            { page: "thread", id: "conv1" },
            { page: "agent", id: "emp1" },
          ],
        },
        live,
      ),
    ).toBeUndefined();
    expect(
      threadOnScreen(
        { page: { page: "threads" }, peek: [{ page: "thread", id: "conv2" }] },
        live,
      ),
    ).toBe("conv2");
  });

  test("Welcome draws no thread: not set up, or the Welcome page, clears it", () => {
    const peek: V3Nav["peek"] = [{ page: "thread", id: "conv1" }];
    expect(
      threadOnScreen(
        { page: { page: "threads" }, peek },
        { setUp: false, features: { tickets: false } },
      ),
    ).toBeUndefined();
    expect(
      threadOnScreen({ page: { page: "welcome" }, peek }, live),
    ).toBeUndefined();
  });
});

describe("visibleNav", () => {
  test("a gated page is Home and a gated record is dropped, until tickets are on", () => {
    const work: V3Nav = {
      page: { page: "work" },
      peek: [{ page: "ticket", id: "t1" }],
    };
    expect(visibleNav(work, false)).toEqual({
      page: { page: "home" },
      peek: [],
    });
    expect(visibleNav(work, true)).toBe(work);
  });

  test("a nav with nothing gated is returned as it is", () => {
    const nav: V3Nav = {
      page: { page: "people" },
      peek: [{ page: "agent", id: "emp1" }],
    };
    expect(visibleNav(nav, false)).toBe(nav);
  });
});

describe("modelLabel", () => {
  const opus = (provider: string): ModelOption => ({
    id: "opus-5",
    name: "Opus 5",
    provider,
  });

  beforeEach(() => {
    engineModels.set([
      opus("anthropic"),
      opus("bedrock"),
      { id: "haiku-5", name: "Haiku 5", provider: "anthropic" },
    ]);
    engineDefaultModel.set(undefined);
    engineDefaultProvider.set(undefined);
    modelVisibility.set({ providers: [], models: [] });
  });

  test("a name two providers share carries its provider, and the label picks the same model back", () => {
    expect(modelLabel("opus-5", "bedrock")).toBe("Opus 5 · bedrock");
    expect(pickFromLabel(modelLabel("opus-5", "bedrock"))).toEqual({
      model: "opus-5",
      provider: "bedrock",
    });
    expect(pickFromLabel(modelLabel("opus-5", "anthropic"))).toEqual({
      model: "opus-5",
      provider: "anthropic",
    });
  });

  test("the engine's default model gets the same disambiguated label", () => {
    engineDefaultModel.set("opus-5");
    engineDefaultProvider.set("bedrock");
    expect(modelLabel("")).toBe("Opus 5 · bedrock");
    expect(pickFromLabel(modelLabel(""))).toEqual({
      model: "opus-5",
      provider: "bedrock",
    });
  });

  test("a name only one model has stays bare", () => {
    expect(modelLabel("haiku-5", "anthropic")).toBe("Haiku 5");
  });

  test("a shared name needs no provider once Settings hides the other one", () => {
    modelVisibility.set({ providers: ["bedrock"], models: [] });
    expect(modelLabel("opus-5", "anthropic")).toBe("Opus 5");
    expect(pickFromLabel("Opus 5")).toEqual({
      model: "opus-5",
      provider: "anthropic",
    });
  });

  test("a hidden model, an unknown id and no default still read as something", () => {
    modelVisibility.set({ providers: ["bedrock"], models: [] });
    expect(modelLabel("opus-5", "bedrock")).toBe("Opus 5");
    expect(modelLabel("mystery-9")).toBe("mystery-9");
    expect(modelLabel("")).toBe("Engine default");
  });
});
