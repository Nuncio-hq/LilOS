import { describe, expect, it } from "vitest";
import {
  aboutLines,
  isSettingsShortcut,
  orderEditors,
  profilePatch,
  updateOutcomeMessage,
} from "../src/settings/state";

/**
 * Issue #132 — Settings (⌘,): the pure helpers behind the wired
 * Settings. AC-1 the shortcut; AC-3 the stored default editor leads and
 * General only saves fields the schema accepts; AC-4 real versions + a
 * plain update-check result.
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

describe("AC-3 the default editor leads editor lists", () => {
  it("moves the stored default first and leaves the rest in detected order", () => {
    const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(orderEditors(list, "b").map((e) => e.id)).toEqual(["b", "a", "c"]);
    expect(orderEditors(list, null)).toEqual(list);
    expect(orderEditors(list, "missing")).toEqual(list);
  });
});

describe("AC-3 General saves only the fields the schema accepts", () => {
  it("profilePatch skips emptied fields the schema would reject", () => {
    expect(profilePatch({ name: "Ada", company: "  " })).toEqual({
      userName: "Ada",
    });
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
