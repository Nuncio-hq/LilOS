import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { useUiLayer } from "../chat/ui-layers";
import { menuArrowKeys } from "../lib/menu-keys";

/* The keyboard behaviour v3's menus and inline editors share, so a keyboard
   user keeps their place: Esc closes the surface you are in and nothing
   behind it, and when a control swaps itself for an editor (or a confirm) the
   keyboard follows it there and back. */

/** Esc closes this surface, not the peek or view behind it: the layer stack
    marks the key as handled, and the shell leaves keys a panel already used
    alone. Mounted only while there is something to close. */
export function EscLayer({ onEscape }: { onEscape: () => void }) {
  useUiLayer({ onEscape });
  return null;
}

/** For the control that opens an inline editor or confirm (an Edit button,
    "Rename…"): put the ref on it, pass whether the editor is open, and when it
    closes the keyboard lands back on the control instead of dropping to the
    page. Only when focus did drop: if you moved on to something else while a
    save was still running, that stays where you put it. */
export function useFocusBack<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null);
  const was = useRef(open);
  useEffect(() => {
    const lost =
      !document.activeElement || document.activeElement === document.body;
    if (was.current && !open && lost) ref.current?.focus();
    was.current = open;
  }, [open]);
  return ref;
}

/** For the control inside an inline confirm that should take the keyboard when
    it opens (the safe answer): put the ref on it, pass whether it is open. */
export function useFocusOn<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  return ref;
}

/** A small dropdown menu: its open state, the trigger and the list, and the
    keys. Opening puts the keyboard on the current choice (`aria-checked`) or
    the first item; ↑ ↓ move between the list's buttons; Esc closes the menu
    (not the peek behind it) and returns to the trigger. A press anywhere
    outside the trigger and the list closes it, so only one menu is ever
    open. Give the list `role="menu"` so the layer stack leaves its Esc alone
    too. `triggerRef` is for a caller that also needs the trigger (to focus it
    from outside). */
export function useMenu(triggerRef?: RefObject<HTMLButtonElement | null>) {
  const [open, setOpen] = useState(false);
  const own = useRef<HTMLButtonElement>(null);
  const trigger = triggerRef ?? own;
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const on = list.current?.querySelector<HTMLElement>(
      '[aria-checked="true"]',
    );
    (on ?? list.current?.querySelector<HTMLElement>("button"))?.focus();
  }, [open]);

  /* Outside presses close the menu from the document, in the capture phase:
     not a full-screen catcher behind the list, which a container-query
     ancestor (`contain: layout`) shrinks to its own box, leaving other rows'
     triggers above it and the rest of the page unable to close it. The
     trigger is left out so its own click toggles. */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const at = e.target as Node | null;
      if (at && (list.current?.contains(at) || trigger.current?.contains(at)))
        return;
      /* A portaled popup a menu row opened (the context meter's card,
         #886) is outside `list` but still part of the row — a press there
         must not close the menu and unmount the card mid-click. */
      if ((at as Element | null)?.closest?.("[data-keepopen]")) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, trigger]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    menuArrowKeys(e, "button");
  };

  return { open, setOpen, trigger, list, close, onKeyDown };
}
