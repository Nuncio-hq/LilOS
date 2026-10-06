import type React from "react";

/* Base UI popover/dialog pieces portaled onto the document — open, they own
   Esc so a surface under them must not also act on it. The UI-layer stack
   (ui-layers.ts) checks these against registered layer roots: a match that
   isn't a layer's own dialog is a foreign overlay that eats Esc itself. */
export const OPEN_OVERLAY =
  '[data-slot="popover-content"][data-open], [data-slot="dropdown-menu-content"], [data-slot="select-content"], [data-slot="hover-card-content"][data-state="open"], [data-slot="dialog-content"], [data-slot="dialog-overlay"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

export function composerKeyDown({
  running,
  onStop,
  lastSent,
  setDraft,
  onDismissOverlay,
}: {
  running: boolean;
  onStop?: () => void;
  /** Last message sent from this composer — ArrowUp recalls it (#104). */
  lastSent?: string;
  setDraft: (v: string) => void;
  onDismissOverlay?: () => void;
}) {
  return (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // A surface layer already consumed this key (e.g. ⌘. stopped the turn).
    if (e.isDefaultPrevented?.() || e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      // Esc only ever closes the composer's own overlay (the `@` mention
      // menu). It never stops a turn — that's what ■ / ⌘. are for (#576).
      if (onDismissOverlay) {
        e.preventDefault();
        onDismissOverlay();
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === "." || e.code === "Period")) {
      // ⌘./Ctrl+. — the stop shortcut the Stop button's tooltip names.
      if (running && onStop) {
        e.preventDefault();
        onStop();
      }
      return;
    }
    if (e.key === "ArrowUp" && !e.currentTarget.value.trim()) {
      const prev = lastSent;
      if (prev) {
        e.preventDefault();
        setDraft(prev);
      }
    }
  };
}
