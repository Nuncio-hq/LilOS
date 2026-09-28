// @vitest-environment happy-dom
/* AC tests for issue #139 — the prototype Settings screen. SettingsView lives
   in @lilos/ui (props in, callbacks out); every section renders only when its
   props are passed (D-#19). Esc/Close return the user to the app. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SettingsView } from "../src/settings/settings-view";
import type { DetectedEditor, StatusComponent } from "../src/types";

afterEach(cleanup);

const STATUS_ROWS: StatusComponent[] = [
  { id: "relay", label: "Relay", state: "ok", reason: "Connected" },
  {
    id: "harness",
    label: "Harness",
    state: "ok",
    reason: "Running · 3 sessions",
  },
  {
    id: "engine",
    label: "Engine",
    state: "down",
    reason: "Engine couldn't start — the engine program wasn't found.",
  },
  {
    id: "model",
    label: "Model",
    state: "blocked",
    reason: "Waiting for the engine.",
  },
];

const EDITORS: DetectedEditor[] = [
  {
    id: "vscode",
    name: "Visual Studio Code",
    path: "/Applications/Visual Studio Code.app",
  },
  { id: "cursor", name: "Cursor", path: "/Applications/Cursor.app" },
  { id: "zed", name: "Zed", path: "/Applications/Zed.app" },
];

const MODELS = [
  { id: "qwen", name: "Qwen", provider: "hpc" },
  { id: "gpt-test-5", name: "GPT test 5", provider: "openai" },
];

function fullProps() {
  return {
    onClose: vi.fn(),
    general: {
      me: { name: "Ada", color: "bg-blue-600" },
      onMeChange: vi.fn(),
      company: "Ada Co",
      onCompanyChange: vi.fn(),
      theme: "system" as const,
      onThemeChange: vi.fn(),
    },
    approvals: {
      policy: "smart" as const,
      onPolicy: vi.fn(),
      access: "ask" as const,
      onAccess: vi.fn(),
    },
    editors: { detected: EDITORS, defaultId: "vscode", onDefault: vi.fn() },
    models: {
      models: MODELS,
      providers: [{ id: "hpc", name: "HPC" }],
      providerLabel: (id: string) => id,
      visibility: { providers: [], models: [] },
      onVisibility: vi.fn(),
    },
    status: { components: STATUS_ROWS, diagnostics: "diag", onCopied: vi.fn() },
    about: { version: "0.1.0", build: "prototype", onCheckUpdates: vi.fn() },
  };
}

const body = () => document.body as HTMLElement;

describe("AC-1 (#139) SettingsView lives in @lilos/ui with a section list", () => {
  test("every section is listed when its props are passed", () => {
    const p = fullProps();
    render(<SettingsView {...p} />);
    const dialog = within(body()).getByRole("dialog", { name: "Settings" });
    const tabs = within(dialog)
      .getAllByRole("tab")
      .map((t) => t.textContent);
    expect(tabs).toEqual([
      "General",
      "Approvals",
      "Editors",
      "Models",
      "Status",
      "About",
    ]);
  });

  test("a section renders only when its props are passed (D-#19)", () => {
    const p = fullProps();
    render(
      <SettingsView onClose={p.onClose} general={p.general} about={p.about} />,
    );
    const dialog = within(body()).getByRole("dialog", { name: "Settings" });
    const tabs = within(dialog)
      .getAllByRole("tab")
      .map((t) => t.textContent);
    expect(tabs).toEqual(["General", "About"]);
  });

  test("clicking a section tab shows its pane", () => {
    const p = fullProps();
    render(<SettingsView {...p} />);
    const dialog = within(body()).getByRole("dialog", { name: "Settings" });
    fireEvent.click(within(dialog).getByRole("tab", { name: "Status" }));
    expect(
      within(dialog).getByText(
        "Engine couldn't start — the engine program wasn't found.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog)
        .getByRole("tab", { name: "Status" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });
});

describe("AC-2 (#139) sections carry working controls", () => {
  test("General: name, company, avatar colour and theme all report changes", () => {
    const p = fullProps();
    render(<SettingsView {...p} />);
    const dialog = within(body()).getByRole("dialog", { name: "Settings" });

    fireEvent.change(within(dialog).getByLabelText("Your name"), {
      target: { value: "Ozzy" },
    });
    expect(p.general.onMeChange).toHaveBeenCalledWith({
      name: "Ozzy",
      color: "bg-blue-600",
    });

    fireEvent.change(within(dialog).getByLabelText("Company name"), {
      target: { value: "Ada Industries" },
    });
    expect(p.general.onCompanyChange).toHaveBeenCalledWith("Ada Industries");

    fireEvent.click(within(dialog).getByRole("radio", { name: "Rose" }));
    expect(p.general.onMeChange).toHaveBeenCalledWith({
      name: "Ada",
      color: "bg-rose-600",
    });

    fireEvent.click(within(dialog).getByRole("radio", { name: "Dark" }));
    expect(p.general.onThemeChange).toHaveBeenCalledWith("dark");
  });

  test("Approvals: policy and new-conversation access report changes", () => {
    const p = fullProps();
    render(<SettingsView {...p} />);
    const dialog = within(body()).getByRole("dialog", { name: "Settings" });
    fireEvent.click(within(dialog).getByRole("tab", { name: "Approvals" }));
    fireEvent.click(within(dialog).getByRole("radio", { name: "Manual" }));
    expect(p.approvals.onPolicy).toHaveBeenCalledWith("manual");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Full access" }));
    expect(p.approvals.onAccess).toHaveBeenCalledWith("full");
  });

  test("Editors: picking a row makes it the default", () => {
    const p = fullProps();
    render(<SettingsView {...p} />);
    const dialog = within(body()).getByRole("dialog", { name: "Settings" });
    fireEvent.click(within(dialog).getByRole("tab", { name: "Editors" }));
    fireEvent.click(within(dialog).getByRole("radio", { name: /Zed/ }));
    expect(p.editors.onDefault).toHaveBeenCalledWith("zed");
  });

  test("Models: Manage opens the model visibility dialog and edits report", async () => {
    const p = fullProps();
    render(<SettingsView {...p} />);
    const dialog = within(body()).getByRole("dialog", { name: "Settings" });
    fireEvent.click(within(dialog).getByRole("tab", { name: "Models" }));
    await act(async () =>
      fireEvent.click(
        within(dialog).getByRole("button", { name: /Manage models/ }),
      ),
    );
    const modelsDialog = within(body()).getByRole("dialog", { name: "Models" });
    await act(async () =>
      fireEvent.click(
        within(modelsDialog).getByRole("switch", { name: "Show Qwen" }),
      ),
    );
    expect(p.models.onVisibility).toHaveBeenCalled();
  });

  test("About: version renders and Check for updates reports", () => {
    const p = fullProps();
    render(<SettingsView {...p} />);
    const dialog = within(body()).getByRole("dialog", { name: "Settings" });
    fireEvent.click(within(dialog).getByRole("tab", { name: "About" }));
    expect(within(dialog).getByText("0.1.0")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Check for updates" }),
    );
    expect(p.about.onCheckUpdates).toHaveBeenCalled();
  });
});

describe("AC-3 (#139) Esc / Close return to the app", () => {
  test("Escape closes Settings", () => {
    const p = fullProps();
    render(<SettingsView {...p} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(p.onClose).toHaveBeenCalled();
  });

  test("the Close button closes Settings", () => {
    const p = fullProps();
    render(<SettingsView {...p} />);
    fireEvent.click(
      within(body()).getByRole("button", { name: "Close settings" }),
    );
    expect(p.onClose).toHaveBeenCalled();
  });
});
