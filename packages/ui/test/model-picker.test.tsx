// @vitest-environment happy-dom
/* AC tests for issue #30: the picker lists the models the ENGINE reported
   (grouped by provider), a pick reports the engine's model id for the next
   turn, and the control only exists when the engine declared `models`. */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { FocusComposer, ModelPicker } from "../src/chat/model-picker";
import type { ModelOption } from "../src/types";

/* happy-dom does not implement every browser API the vendored components touch. */
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof Element.prototype.scrollIntoView === "undefined") {
  Element.prototype.scrollIntoView = () => {};
}
afterEach(cleanup);

/* A multi-provider catalog like a real `models.list` answer. */
const MODELS: ModelOption[] = [
  { id: "gpt-test-5", name: "GPT test 5", provider: "openai" },
  { id: "gpt-test-4o", provider: "openai" },
  { id: "claude-test-4.5", name: "Claude test 4.5", provider: "anthropic" },
  { id: "orphan-1" },
];

const openPicker = () => {
  const el =
    document.body.querySelector('[data-slot="model-selector-trigger"]') ??
    document.body.querySelector("button");
  if (!el) throw new Error("no picker trigger");
  fireEvent.click(el);
};

describe("model picker (issue #30)", () => {
  test("AC-1 lists the engine's models grouped by provider", async () => {
    render(
      <ModelPicker model="gpt-test-5" models={MODELS} onModel={() => {}} />,
    );
    openPicker();
    // The pick surface is a dialog; the group headings are provider display
    // names (issue #71, AC-7 — never the raw slug).
    const headings = [
      ...document.body.querySelectorAll("[cmdk-group-heading]"),
    ].map((el) => el.textContent);
    expect(headings).toEqual(["OpenAI", "Anthropic", "Other"]);
    // Every engine-reported model is a row — providerless ones land in Other.
    const dialog = document.body.querySelector(
      '[role="dialog"]',
    ) as HTMLElement;
    expect(dialog).toBeTruthy();
    for (const label of ["gpt-test-4o", "Claude test 4.5", "orphan-1"]) {
      expect(within(dialog).getByText(label)).toBeTruthy();
    }
  });

  test("AC-2 picking a row reports the engine's model id", () => {
    const picks: string[] = [];
    render(
      <ModelPicker
        model="gpt-test-5"
        models={MODELS}
        onModel={(m) => picks.push(m)}
      />,
    );
    openPicker();
    // Click the row showing the friendly name; the callback gets the id.
    fireEvent.click(
      within(document.body as HTMLElement).getByText("Claude test 4.5"),
    );
    expect(picks).toEqual(["claude-test-4.5"]);
  });

  test("AC-3 the composer shows no picker without a handler or a model list", () => {
    const props = {
      running: false,
      status: "ready" as const,
      placeholder: "Message…",
      hint: "",
      onSend: () => {},
    };
    // Engine lacks `models` → the app passes neither handler nor list.
    const off = render(<FocusComposer {...props} />);
    expect(
      off.container.querySelector('[data-slot="dialog-trigger"]'),
    ).toBeNull();
    // List but no handler → still nothing (D-#19: controls need their handler).
    const noHandler = render(<FocusComposer {...props} models={MODELS} />);
    expect(
      noHandler.container.querySelector('[data-slot="dialog-trigger"]'),
    ).toBeNull();
  });
});
