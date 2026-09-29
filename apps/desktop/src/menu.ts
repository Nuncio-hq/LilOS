import type { MenuItemConstructorOptions } from "electron";

/**
 * The LilOS application menu (issue #132 AC-1): "Settings…" carries ⌘, and
 * asks the app window to open its Settings screen; "Service Status" (#34)
 * stays its own item with no accelerator. The template is a pure value so
 * unit tests exercise it without an Electron runtime, and so the window
 * work in #232 merges beside it.
 */
export function appMenuTemplate(
  openSettings: () => void,
  openStatus: () => void,
): MenuItemConstructorOptions[] {
  return [
    {
      label: "LilOS",
      submenu: [
        {
          id: "settings",
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          click: openSettings,
        },
        { type: "separator" },
        {
          id: "service-status",
          label: "Service Status",
          click: openStatus,
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { label: "Edit", role: "editMenu" },
    { label: "View", role: "viewMenu" },
  ];
}
