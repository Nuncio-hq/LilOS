/**
 * Issue #132 AC-1 — the LilOS menu: "Settings…" carries ⌘, and routes into
 * the app window; "Service Status" stays its own item with no accelerator.
 * Issue #554 AC-2 — Find lives in the Edit menu: "Find…" ⌘F opens the
 * thread find bar, "Find Next" ⌘G and "Find Previous" ⇧⌘G walk matches.
 * The template is a pure value so this test needs no Electron runtime.
 */
import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
import { appMenuTemplate } from "../src/menu";

const menus = () => {
  const calls: string[] = [];
  const items = appMenuTemplate(
    () => calls.push("settings"),
    () => calls.push("status"),
    (action) => calls.push(`find:${action}`),
    (action) => calls.push(`shortcut:${action}`),
  );
  const appMenu = items.find((i) => i.label === "LilOS");
  const fileMenu = items.find((i) => i.label === "File");
  const editMenu = items.find((i) => i.label === "Edit");
  const goMenu = items.find((i) => i.label === "Go");
  return {
    calls,
    sub: (appMenu?.submenu ?? []) as MenuItemConstructorOptions[],
    file: (fileMenu?.submenu ?? []) as MenuItemConstructorOptions[],
    edit: (editMenu?.submenu ?? []) as MenuItemConstructorOptions[],
    go: (goMenu?.submenu ?? []) as MenuItemConstructorOptions[],
  };
};

describe("AC-1 the LilOS menu", () => {
  it("has Settings… on ⌘, that calls back into the app", () => {
    const { calls, sub } = menus();
    const settings = sub.find((i) => i.id === "settings");
    expect(settings?.label).toBe("Settings…");
    expect(settings?.accelerator).toBe("CmdOrCtrl+,");
    settings?.click?.(settings as never, undefined as never, {} as never);
    expect(calls).toEqual(["settings"]);
  });

  it("keeps Service Status as a plain item with no accelerator", () => {
    const { calls, sub } = menus();
    const status = sub.find((i) => i.id === "service-status");
    expect(status?.label).toBe("Service Status");
    expect(status?.accelerator).toBeUndefined();
    status?.click?.(status as never, undefined as never, {} as never);
    expect(calls).toEqual(["status"]);
  });
});

describe("AC-2 (#554) Find is listed in the Edit menu", () => {
  it("Find… ⌘F / Find Next ⌘G / Find Previous ⇧⌘G route into the window", () => {
    const { calls, edit } = menus();
    const find = edit.find((i) => i.id === "find");
    const next = edit.find((i) => i.id === "find-next");
    const prev = edit.find((i) => i.id === "find-prev");
    expect(find?.label).toBe("Find…");
    expect(find?.accelerator).toBe("CmdOrCtrl+F");
    expect(next?.accelerator).toBe("CmdOrCtrl+G");
    expect(prev?.accelerator).toBe("Shift+CmdOrCtrl+G");
    for (const item of [find, next, prev]) {
      item?.click?.(item as never, undefined as never, {} as never);
    }
    expect(calls).toEqual(["find:open", "find:next", "find:prev"]);
  });
});

describe("keyboard navigation in the app menu", () => {
  it("File → New Session ⌘N routes into the window", () => {
    const { calls, file } = menus();
    const item = file.find((i) => i.label === "New Session");
    expect(item?.accelerator).toBe("CmdOrCtrl+N");
    item?.click?.(item as never, undefined as never, {} as never);
    expect(calls).toEqual(["shortcut:new-session"]);
  });

  it("Go lists every navigation chord and the digit jumps", () => {
    const { calls, go } = menus();
    const byLabel = Object.fromEntries(
      go.filter((i) => i.label).map((i) => [i.label, i]),
    );
    expect(byLabel["Quick Switcher"]?.accelerator).toBe("CmdOrCtrl+K");
    expect(byLabel.Back?.accelerator).toBe("CmdOrCtrl+[");
    expect(byLabel.Forward?.accelerator).toBe("CmdOrCtrl+]");
    expect(byLabel["Keyboard Shortcuts"]?.accelerator).toBe("CmdOrCtrl+/");
    for (let n = 1; n <= 9; n++) {
      expect(byLabel[`Employee ${n}`]?.accelerator).toBe(`CmdOrCtrl+${n}`);
    }
    for (const item of go.filter((i) => i.click)) {
      item.click?.(item as never, undefined as never, {} as never);
    }
    expect(calls).toEqual([
      "shortcut:quick-switcher",
      "shortcut:back",
      "shortcut:forward",
      ...Array.from({ length: 9 }, (_, i) => `shortcut:employee-${i + 1}`),
      "shortcut:shortcuts",
    ]);
  });
});
