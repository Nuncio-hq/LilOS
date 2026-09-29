/**
 * Issue #132 AC-1 — the LilOS menu: "Settings…" carries ⌘, and routes into
 * the app window; "Service Status" stays its own item with no accelerator.
 * The template is a pure value so this test needs no Electron runtime.
 */
import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
import { appMenuTemplate } from "../src/menu";

const lilosSubmenu = () => {
  const calls: string[] = [];
  const items = appMenuTemplate(
    () => calls.push("settings"),
    () => calls.push("status"),
  );
  const appMenu = items.find((i) => i.label === "LilOS");
  const sub = (appMenu?.submenu ?? []) as MenuItemConstructorOptions[];
  return { calls, sub };
};

describe("AC-1 the LilOS menu", () => {
  it("has Settings… on ⌘, that calls back into the app", () => {
    const { calls, sub } = lilosSubmenu();
    const settings = sub.find((i) => i.id === "settings");
    expect(settings?.label).toBe("Settings…");
    expect(settings?.accelerator).toBe("CmdOrCtrl+,");
    settings?.click?.(settings as never, undefined as never, {} as never);
    expect(calls).toEqual(["settings"]);
  });

  it("keeps Service Status as a plain item with no accelerator", () => {
    const { calls, sub } = lilosSubmenu();
    const status = sub.find((i) => i.id === "service-status");
    expect(status?.label).toBe("Service Status");
    expect(status?.accelerator).toBeUndefined();
    status?.click?.(status as never, undefined as never, {} as never);
    expect(calls).toEqual(["status"]);
  });
});
