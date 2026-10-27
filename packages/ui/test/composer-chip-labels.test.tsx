// @vitest-environment happy-dom
/* #897: the model, effort and access chips keep their full label while the
   row has room. They never shrink above the narrow-box threshold (`shrink-0`),
   carry no hard width cap on the effort label. Under `@max-[480px]` (#886) they
   go icon-only without shrinking, so neighbours never overlap. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { AccessPill } from "../src/chat/access-pill";
import { EffortPicker } from "../src/chat/effort-picker";
import { ModelPicker } from "../src/chat/model-picker";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
afterEach(cleanup);

const noShrinkAboveNarrow = (el: Element | null) => {
  const cls = el?.className ?? "";
  expect(cls).toContain("shrink-0");
  expect(cls).not.toMatch(/(^|\s)shrink(\s|$)/);
  expect(cls).not.toContain("@max-[480px]:shrink");
};

/* Narrow box: the label steps aside for the icon, the trigger keeps its own
   width (so neighbours never overlap), and the chevron goes first. */
const iconOnlyNarrow = (el: Element | null) => {
  expect(el?.className).toContain("@max-[480px]:px-1");
  expect(
    el?.querySelector("svg.lucide-chevron-down")?.getAttribute("class"),
  ).toContain("@max-[680px]:hidden");
};

test("effort chip: no shrink above narrow, no label cap", () => {
  const { container } = render(
    <EffortPicker
      efforts={["low", "xhigh"]}
      effort="xhigh"
      onPick={() => {}}
    />,
  );
  const effortTrigger = container.querySelector(
    '[data-slot="effort-picker-trigger"]',
  );
  noShrinkAboveNarrow(effortTrigger);
  iconOnlyNarrow(effortTrigger);
  /* Lowest priority: gone when even icons don't fit. */
  expect(effortTrigger?.className).toContain("@max-[260px]:hidden");
  const label = container.querySelector("[data-effort]");
  expect(label?.textContent).toBe("Extra high");
  expect(label?.className).not.toMatch(/max-w-/);
});

test("model chip: no shrink above narrow, title carries the full name", () => {
  const { container } = render(
    <ModelPicker
      value={{ model: "claude-opus-5-5", provider: "anthropic" }}
      models={[
        {
          id: "claude-opus-5-5",
          name: "Claude Opus 5.5 with a very long display name",
          provider: "anthropic",
        },
      ]}
      onChoice={() => {}}
    />,
  );
  const trigger = container.querySelector('[data-slot="model-picker-trigger"]');
  noShrinkAboveNarrow(trigger);
  iconOnlyNarrow(trigger);
  expect(trigger?.querySelector("span")?.className).toContain(
    "@max-[480px]:hidden",
  );
  expect(trigger?.getAttribute("title")).toBe(
    "Claude Opus 5.5 with a very long display name",
  );
});

test("access chip: no shrink above narrow", () => {
  const { container } = render(
    <AccessPill
      access="ask"
      onAccess={() => {}}
      engineNeverAsks
      engineName="Hermes"
    />,
  );
  const pill = container.querySelector('[data-slot="access-pill"]');
  noShrinkAboveNarrow(pill);
  iconOnlyNarrow(pill);
  expect(container.textContent).toContain("Never asks");
});
