// @vitest-environment happy-dom
/* AC tests for issue #53: `blocked` is a neutral leg state that does not count
   as an issue, a downed leg shows a plain reason + next step, and the raw
   error lives in a collapsed details line. */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { StatusDialog, StatusRow, statusSummary } from "../src/shell/status";
import type { StatusComponent } from "../src/types";

afterEach(cleanup);

const ok = (id: StatusComponent["id"], label: string): StatusComponent => ({
  id,
  label,
  state: "ok",
  reason: `${label} ok`,
});

describe("AC-2 (#53) blocked legs do not count as issues", () => {
  test("statusSummary counts only the real failure", () => {
    const components: StatusComponent[] = [
      ok("relay", "Relay"),
      {
        id: "harness",
        label: "Harness",
        state: "down",
        reason: "Harness lost its connection.",
      },
      {
        id: "engine",
        label: "Engine",
        state: "blocked",
        reason: "Waiting for the harness.",
      },
      {
        id: "model",
        label: "Model",
        state: "blocked",
        reason: "Waiting for the harness.",
      },
    ];
    expect(statusSummary(components)).toBe("1 issue · Harness down");
  });

  test("all ok + one blocked upstream-waiting stays clean when nothing is down", () => {
    const components: StatusComponent[] = [
      ok("relay", "Relay"),
      ok("harness", "Harness"),
      {
        id: "engine",
        label: "Engine",
        state: "connecting",
        reason: "Engine starting",
      },
      {
        id: "model",
        label: "Model",
        state: "blocked",
        reason: "Waiting for the engine.",
      },
    ];
    // connecting still surfaces; blocked does not add to the count.
    expect(statusSummary(components)).toBe("1 issue · Engine connecting");
  });

  test("StatusRow reports the same count", () => {
    const components: StatusComponent[] = [
      ok("relay", "Relay"),
      {
        id: "harness",
        label: "Harness",
        state: "down",
        reason: "Harness lost its connection.",
      },
      {
        id: "engine",
        label: "Engine",
        state: "blocked",
        reason: "Waiting for the harness.",
      },
      {
        id: "model",
        label: "Model",
        state: "blocked",
        reason: "Waiting for the harness.",
      },
    ];
    const { getByRole } = render(
      <StatusRow components={components} onOpen={() => {}} />,
    );
    expect(
      getByRole("button", { name: "System status" }).textContent,
    ).toContain("1 issue");
  });
});

describe("AC-1 (#53) the dialog shows plain reason, next step, collapsed details", () => {
  const components: StatusComponent[] = [
    ok("relay", "Relay"),
    ok("harness", "Harness"),
    {
      id: "engine",
      label: "Engine",
      state: "down",
      reason: "Engine couldn't start — the engine program wasn't found.",
      hint: "Check the engine path in Settings.",
      detail:
        "engine broken-engine failed to start x5: Error: spawn /nonexistent/lilos-engine ENOENT",
    },
    {
      id: "model",
      label: "Model",
      state: "blocked",
      reason: "Waiting for the engine.",
    },
  ];

  test("a down leg renders the plain reason + hint; raw stays collapsed", () => {
    const { getByRole, container } = render(
      <StatusDialog
        components={components}
        diagnostics="diag"
        onClose={() => {}}
        onCopied={() => {}}
      />,
    );
    const dialog = getByRole("dialog", { name: "System status" });
    expect(within(dialog).getByText(/couldn't start/)).toBeTruthy();
    expect(
      within(dialog).getByText(/Check the engine path in Settings/),
    ).toBeTruthy();
    // The raw error is inside a collapsed <details>, not the visible reason.
    const details = container.querySelector("details");
    expect(details).toBeTruthy();
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.textContent).toContain("ENOENT");
    fireEvent.click(within(details as HTMLElement).getByText("Details"));
    expect(details?.hasAttribute("open")).toBe(true);
  });

  test("a blocked leg renders as neutral, not red", () => {
    const { getByRole } = render(
      <StatusDialog
        components={components}
        diagnostics="diag"
        onClose={() => {}}
        onCopied={() => {}}
      />,
    );
    const dialog = getByRole("dialog", { name: "System status" });
    expect(within(dialog).getByText("Waiting for the engine.")).toBeTruthy();
    expect(within(dialog).getByText("blocked")).toBeTruthy();
  });
});
