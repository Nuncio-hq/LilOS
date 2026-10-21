import type { DesktopShortcutAction } from "@lilos/contracts/app";
import type { MenuItemConstructorOptions } from "electron";

/**
 * The LilOS application menu (issue #132 AC-1): "Settings…" carries ⌘, and
 * asks the app window to open its Settings screen; "Service Status" (#34)
 * stays its own item with no accelerator. The template is a pure value so
 * unit tests exercise it without an Electron runtime, and so the window
 * work in #232 merges beside it.
 *
 * The Edit submenu is written out (not `role: "editMenu"`) so Find lives
 * there too (#554): the standard roles keep ⌘Z/⌘X/⌘C/⌘V/⌘A, then the Find
 * items carry the macOS chords — ⌘F opens the thread find bar, ⌘G / ⇧⌘G
 * walk matches. Each click forwards to the app window, where the find bar
 * runs the DOM find itself (findInPage would match the bar's own input).
 */
export type FindMenuAction = "open" | "next" | "prev";

export function appMenuTemplate(
  openSettings: () => void,
  openStatus: () => void,
  onFind: (action: FindMenuAction) => void,
  onShortcut: (action: DesktopShortcutAction) => void,
  onBrowser: () => void,
): MenuItemConstructorOptions[] {
  const item = (
    label: string,
    accelerator: string,
    action: DesktopShortcutAction,
  ): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => onShortcut(action),
  });
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
    {
      label: "File",
      submenu: [
        item("New Session", "CmdOrCtrl+N", "new-session"),
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      /* The stock editMenu's items, written out so Find can join it —
         Paste and Match Style + Delete keep the role menu's set (#554). */
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
        { type: "separator" },
        {
          id: "find",
          label: "Find…",
          accelerator: "CmdOrCtrl+F",
          click: () => onFind("open"),
        },
        {
          id: "find-next",
          label: "Find Next",
          accelerator: "CmdOrCtrl+G",
          click: () => onFind("next"),
        },
        {
          id: "find-prev",
          label: "Find Previous",
          accelerator: "Shift+CmdOrCtrl+G",
          click: () => onFind("prev"),
        },
      ],
    },
    {
      /* The accelerators consume the chord before the page sees it, so the
         renderer only ever hears the shortcut action — the same handlers
         the browser-reserved chords can't bind on web. */
      label: "Go",
      submenu: [
        item("Quick Switcher", "CmdOrCtrl+K", "quick-switcher"),
        item("Back", "CmdOrCtrl+[", "back"),
        item("Forward", "CmdOrCtrl+]", "forward"),
        { type: "separator" },
        ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) =>
          item(
            `Employee ${n}`,
            `CmdOrCtrl+${n}`,
            `employee-${n}` as DesktopShortcutAction,
          ),
        ),
        { type: "separator" },
        item("Keyboard Shortcuts", "CmdOrCtrl+/", "shortcuts"),
      ],
    },
    {
      label: "View",
      /* Written out instead of `role: "viewMenu"` so the browser toggle
         can live here: ⌘⇧B opens/closes the LilOS Browser. Its click runs
         in main (the host owns the open state), so it also fires while a
         page's view has focus. Zoom/devtools roles stay out on purpose:
         their accelerators would consume ⌘+/⌘-/⌘0/⌥⌘I before a focused
         page's view sees them, bypassing the host's zoom state. */
      submenu: [
        /* ⌘\ hides and shows the v3 sidebar. The accelerator consumes the
           chord, so the renderer hears it as a shortcut action. */
        item("Toggle Sidebar", "CmdOrCtrl+\\", "toggle-sidebar"),
        { type: "separator" },
        {
          id: "browser",
          label: "LilOS Browser",
          accelerator: "CmdOrCtrl+Shift+B",
          click: onBrowser,
        },
        { type: "separator" },
        { role: "reload" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ];
}
