// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type LiveSurfaces, LiveTerminal } from "../src/workbench/live";

afterEach(cleanup);

const live = (termControl: "agent" | "user"): LiveSurfaces => ({
  termText: "$ echo hi\nhi\n$ ",
  terminal: { cols: 110, rows: 28 },
  frame: null,
  page: { width: 1280, height: 800 },
  url: null,
  previews: [],
  activity: [],
  termControl,
  releaseTerminal: () => {},
  sendInput: () => {},
  resize: () => {},
  navigate: () => {},
  resizeBrowser: () => {},
  input: () => {},
});

describe("AC-2 takeover state shows across the pane", () => {
  it("agent-held terminal: green `live` badge, no takeover note", () => {
    const { container } = render(
      <LiveTerminal live={live("agent")} cwd="/repo" agentName="Builder" />,
    );
    const badge = container.querySelector("span.bg-emerald-800");
    expect(badge?.textContent).toBe("live");
    expect(container.textContent).not.toContain("you");
  });

  it("user-held terminal: amber `you` badge replaces `live`, banner stays", () => {
    const { container } = render(
      <LiveTerminal live={live("user")} cwd="/repo" agentName="Builder" />,
    );
    const badge = container.querySelector("span.bg-amber-800");
    expect(badge?.textContent).toBe("you");
    expect(container.querySelector("span.bg-emerald-800")).toBeNull();
    expect(container.textContent).toContain("in control");
  });
});
