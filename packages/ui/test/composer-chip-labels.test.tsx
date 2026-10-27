// @vitest-environment happy-dom
/* #897: the model, effort and access chips keep their full label while the
   row has room. They never shrink above the narrow-box threshold (`shrink-0`),
   carry no hard width cap on the effort label, and shrink only under the
   `@max-[480px]` container query (#886). The label's title keeps the full
   name when it does truncate. */
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
  expect(cls).toContain("@max-[480px]:shrink");
  expect(cls).not.toMatch(/(^|\s)shrink(\s|$)/);
};

test("effort chip: no shrink above narrow, no label cap", () => {
  const { container } = render(
    <EffortPicker
      efforts={["low", "xhigh"]}
      effort="xhigh"
      onPick={() => {}}
    />,
  );
  noShrinkAboveNarrow(
    container.querySelector('[data-slot="effort-picker-trigger"]'),
  );
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
  noShrinkAboveNarrow(container.querySelector('[data-slot="access-pill"]'));
  expect(container.textContent).toContain("Never asks");
});
