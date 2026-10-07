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
  );
  const appMenu = items.find((i) => i.label === "LilOS");
  const editMenu = items.find((i) => i.label === "Edit");
  return {
    calls,
    sub: (appMenu?.submenu ?? []) as MenuItemConstructorOptions[],
    edit: (editMenu?.submenu ?? []) as MenuItemConstructorOptions[],
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
