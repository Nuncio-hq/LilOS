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
  onBrowser: () => void,
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
      label: "View",
      /* Written out so the browser toggle can live here: ⌘⇧B opens/closes
         the LilOS Browser. Its click runs in main (the host owns the
         open state), so it also fires while a page's view has focus. */
      submenu: [
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
