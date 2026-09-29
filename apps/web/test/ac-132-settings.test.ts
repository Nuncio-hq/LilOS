import { describe, expect, it } from "vitest";
import {
  aboutLines,
  editorsProps,
  isSettingsShortcut,
  orderEditors,
  profilePatch,
  settledDrafts,
  toDetectedEditor,
  updateOutcomeMessage,
} from "../src/settings/state";

/**
 * Issue #132 — Settings (⌘,): the pure helpers behind the wired
 * SettingsView. AC-1 the shortcut; AC-2 sections only with real data;
 * AC-3 the stored default editor leads and edits settle against the
 * relay's echo; AC-4 real versions + a plain update-check result.
 */

describe("AC-1 the ⌘, shortcut", () => {
  it("matches cmd-, and ctrl-, and nothing else", () => {
    expect(
      isSettingsShortcut({ key: ",", metaKey: true, ctrlKey: false }),
    ).toBe(true);
    expect(
      isSettingsShortcut({ key: ",", metaKey: false, ctrlKey: true }),
    ).toBe(true);
    expect(
      isSettingsShortcut({ key: ",", metaKey: false, ctrlKey: false }),
    ).toBe(false);
    expect(
      isSettingsShortcut({ key: "k", metaKey: true, ctrlKey: false }),
    ).toBe(false);
    expect(
      isSettingsShortcut({ key: ",", metaKey: false, ctrlKey: true }),
    ).toBe(true);
  });
});

describe("AC-2 the Editors section renders only with detected editors", () => {
  const detected = [
    { id: "vscode", name: "Visual Studio Code", app: "/Applications/Code.app" },
    { id: "cursor", name: "Cursor", app: "/Applications/Cursor.app" },
    { id: "zed", name: "Zed" },
  ];

  it("is hidden when nothing was detected", () => {
    expect(editorsProps(null, "zed")).toBeUndefined();
    expect(editorsProps([], "zed")).toBeUndefined();
  });

  it("maps the host row (app path) and marks the stored default", () => {
    const props = editorsProps(detected, "cursor");
    expect(props?.detected).toEqual([
      {
        id: "vscode",
        name: "Visual Studio Code",
        path: "/Applications/Code.app",
      },
      { id: "cursor", name: "Cursor", path: "/Applications/Cursor.app" },
      { id: "zed", name: "Zed" },
    ]);
    expect(props?.defaultId).toBe("cursor");
  });

  it("defaults to the first detected editor when nothing is stored", () => {
    expect(editorsProps(detected, null)?.defaultId).toBe("vscode");
  });

  it("falls back to the first detected editor when the stored one was uninstalled", () => {
    expect(editorsProps(detected, "xcode")?.defaultId).toBe("vscode");
  });
});

describe("AC-3 the default editor leads editor lists", () => {
  it("moves the stored default first and leaves the rest in detected order", () => {
    const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(orderEditors(list, "b").map((e) => e.id)).toEqual(["b", "a", "c"]);
    expect(orderEditors(list, null)).toEqual(list);
    expect(orderEditors(list, "missing")).toEqual(list);
  });
});

describe("AC-3 General edits draft locally and settle on the relay's echo", () => {
  it("keeps fields the relay has not caught up to, drops the ones it has", () => {
    expect(
      settledDrafts(
        { name: "Ada", company: "Acme" },
        { name: "Ada", company: "My Co", color: "bg-blue-600" },
      ),
    ).toEqual({ company: "Acme" });
    expect(
      settledDrafts(
        { name: "Ada" },
        { name: "Grace", company: "My Co", color: "bg-blue-600" },
      ),
    ).toEqual({ name: "Ada" });
    expect(
      settledDrafts(
        {},
        { name: "Grace", company: "My Co", color: "bg-blue-600" },
      ),
    ).toEqual({});
  });

  it("profilePatch skips emptied fields the schema would reject", () => {
    expect(
      profilePatch({ name: "Ada", company: "  ", color: "bg-red-500" }),
    ).toEqual({ userName: "Ada", avatarColor: "bg-red-500" });
    expect(profilePatch({ name: " ", company: " " })).toEqual({});
  });
});

describe("AC-4 About shows real versions and the check reports plainly", () => {
  it("prefers the desktop app version and lists build · relay · harness", () => {
    expect(
      aboutLines({
        app: { version: "1.0.123", build: 123 },
        versions: { relay: "1.0.123", harness: "1.0.123" },
      }),
    ).toEqual({
      version: "1.0.123",
      build: "build 123 · relay 1.0.123 · harness 1.0.123",
    });
  });

  it("on plain web the relay version is the app version", () => {
    expect(
      aboutLines({ versions: { relay: "0.4.0", harness: "0.4.0" } }),
    ).toEqual({
      version: "0.4.0",
      build: "relay 0.4.0 · harness 0.4.0",
    });
    expect(aboutLines({})).toEqual({ version: undefined, build: undefined });
  });

  it("maps the update-check outcome to a plain sentence", () => {
    expect(updateOutcomeMessage("none")).toMatch(/up to date/i);
    expect(updateOutcomeMessage("apply-ready")).toMatch(/restart/i);
    expect(updateOutcomeMessage("failed")).toMatch(/failed/i);
    expect(updateOutcomeMessage("disabled")).toMatch(/off/i);
  });
});

describe("toDetectedEditor", () => {
  it("carries the bundle path only when the host reported one", () => {
    expect(
      toDetectedEditor({
        id: "zed",
        name: "Zed",
        app: "/Applications/Zed.app",
      }),
    ).toEqual({ id: "zed", name: "Zed", path: "/Applications/Zed.app" });
    expect(toDetectedEditor({ id: "zed", name: "Zed" })).toEqual({
      id: "zed",
      name: "Zed",
    });
  });
});
