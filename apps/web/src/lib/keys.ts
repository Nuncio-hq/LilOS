import type { DesktopShortcutAction } from "@lilos/contracts/app";

/* App-level keyboard navigation: the chords a browser doesn't reserve map
   here (the reserved ones — ⌘N, ⌘1–9 — only ever arrive as menu actions over
   lilos:shortcut inside the Electron shell); v3/effects.ts binds both paths
   through one dispatch. */

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
