import type { KeyboardEvent } from "react";

/* Arrow-key walking for a hand-built `role="menu"` (#886): ↓ ↑ move between
   the rows and wrap, Home / End jump to the ends. Focus on the menu itself
   (a popover opens with focus on its container) enters at the checked row
   going down, at the last row going up. Returns true when it used the key. */

const ROWS = '[role^="menuitem"]:not(:disabled)';

export function menuArrowKeys(
  e: KeyboardEvent<HTMLElement>,
  rows: string = ROWS,
): boolean {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(e.key)) return false;
  // Home / End belong to a text box's caret.
  if (
    (e.key === "Home" || e.key === "End") &&
    (e.target as HTMLElement).closest("input, textarea")
  )
    return false;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(rows)];
  if (items.length === 0) return false;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  let to: number;
  if (e.key === "Home") to = 0;
  else if (e.key === "End") to = items.length - 1;
  else if (at < 0) {
    const checked = items.findIndex(
      (i) => i.getAttribute("aria-checked") === "true",
    );
    to = e.key === "ArrowDown" ? Math.max(checked, 0) : items.length - 1;
  } else {
    const step = e.key === "ArrowDown" ? 1 : -1;
    to = (at + step + items.length) % items.length;
  }
  items[to]?.focus();
  return true;
}
