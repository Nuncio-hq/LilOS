import type {
  DesktopBridge,
  DesktopShortcutAction,
} from "@lilos/contracts/app";

/* App-level keyboard navigation: the chords a browser doesn't reserve are
   bound here on keydown; the reserved ones (⌘N, ⌘1–9) only ever arrive as
   menu actions over lilos:shortcut inside the Electron shell, so both
   paths run through one dispatch. */

/** The web-bindable chords — ⌘K, ⌘/, ⌘[, ⌘]. ⌘N and the digit chords are
 *  browser-reserved, so on web they're simply unbound and on desktop they
 *  arrive over lilos:shortcut instead. Binding them here too would be dead
 *  code: the menu accelerator consumes the keypress before the page sees
 *  it, and a plain browser never delivers it. */
export function shortcutFromKey(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): DesktopShortcutAction | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return null;
  const k = e.key.toLowerCase();
  if (k === "k") return "quick-switcher";
  if (k === "/") return "shortcuts";
  if (k === "[") return "back";
  if (k === "]") return "forward";
  return null;
}

export type ShortcutHandlers = {
  [K in DesktopShortcutAction]: () => void;
};

/** Bind the web-safe chords on keydown and the menu-delivered actions on
 *  the desktop bridge. Returns an unsubscribe covering both. */
export function bindAppShortcuts(
  handlers: ShortcutHandlers,
  bridge: DesktopBridge | undefined,
): () => void {
  const run = (action: DesktopShortcutAction) => handlers[action]();
  const onKey = (e: KeyboardEvent) => {
    /* IME composition owns its keys — a chord swallowed mid-composition
       eats the user's text. The terminal view likewise owns its keys;
       its surface is marked data-lilos-terminal so focus inside it is
       enough to skip the map. */
    if (e.isComposing) return;
    const action = shortcutFromKey(e);
    if (!action) return;
    const el = e.target as HTMLElement | null;
    if (el?.closest?.("[data-lilos-terminal]")) return;
    e.preventDefault();
    run(action);
  };
  window.addEventListener("keydown", onKey);
  const offBridge = bridge?.onShortcut?.(run);
  return () => {
    window.removeEventListener("keydown", onKey);
    offBridge?.();
  };
}
