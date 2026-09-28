import type { KeyboardEventHandler } from "react";

/* Esc / ArrowUp on top of plain typing, shared by Composer and FocusComposer
   so every surface does the same thing (issue #104):
   - Esc calls the same `onStop` the Stop button calls, but only while a turn
     runs — and only when no overlay owns the press: an open popover, menu or
     dialog takes the Esc to close itself first, so the turn is never stopped
     by a key the user meant for the overlay.
   - ArrowUp in an EMPTY composer recalls `lastSent` (the last message you
     sent), caret at the end; with text it keeps the usual caret move. */

/* Base UI popups stay mounted while open (`data-open`; `data-closed` only
   while animating out) and role'd overlays mount only while shown — DOM
   presence means this Esc belongs to the overlay. Tooltips are excluded on
   purpose: a visible tooltip must not swallow a stop. */
const OPEN_OVERLAY = [
  '[data-slot="popover-content"][data-open]',
  '[data-slot="popover-content"][data-closed]',
  '[data-slot="dropdown-menu-content"][data-open]',
  '[data-slot="select-content"][data-open]',
  '[data-slot="hover-card-content"][data-open]',
  '[data-slot="dialog-content"]',
  '[data-slot="dialog-overlay"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
].join(", ");

/** True while a popup/menu/dialog owns Esc — exported so surfaces that add
    their own Esc handling (Focus exits, issue #114) yield to it too. */
export const overlayOpen = () => !!document.querySelector(OPEN_OVERLAY);

export function composerKeyDown({
  running,
  onStop,
  lastSent,
  setDraft,
  onDismissOverlay,
}: {
  /* A turn is running — the same precondition the Stop button shows on. */
  running: boolean;
  /* The very handler the Stop button calls; absent → Esc does nothing. */
  onStop?: () => void;
  /* The last sent message ↑ recalls; absent → ↑ stays a caret move. */
  lastSent?: string;
  setDraft: (text: string) => void;
  /* A composer-owned popup is open (the `@` employee menu): Esc closes it
     instead of stopping the turn. Pass only while it is actually open. */
  onDismissOverlay?: () => void;
}): KeyboardEventHandler<HTMLTextAreaElement> {
  return (e) => {
    // IME composition in progress: Esc cancels the composition and ↑ walks the
    // candidate list — never stop the turn or recall on keys the IME owns.
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      if (onDismissOverlay) {
        e.preventDefault();
        onDismissOverlay();
        return;
      }
      if (overlayOpen()) return;
      if (running && onStop) {
        e.preventDefault();
        onStop();
      }
      return;
    }
    if (
      e.key === "ArrowUp" &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      const el = e.currentTarget;
      if (el.value === "" && lastSent) {
        e.preventDefault();
        setDraft(lastSent);
        // Caret lands at the end once React has committed the new value.
        requestAnimationFrame(() =>
          el.setSelectionRange(el.value.length, el.value.length),
        );
      }
    }
  };
}
