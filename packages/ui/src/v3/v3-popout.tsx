import { useCallback, useEffect, useRef, useState } from "react";

/* A hidden sidebar is still one hover away. The pointer at the window's left
   edge slides it out over the page; it tucks away a moment after the pointer
   leaves, so a stray flick off the edge does not snatch it from under you. It
   stays while keyboard focus is inside (a click leaves a button focused but not
   focus-visible, so it does not count: clicking Threads and moving away still
   tucks it). Esc tucks it too, from the shell. */

const TUCK_DELAY = 280;

export function useSidebarPopout(hidden: boolean) {
  const [popped, setPopped] = useState(false);
  const side = useRef<HTMLElement>(null);
  const timer = useRef<number>(undefined);

  const cancel = useCallback(() => window.clearTimeout(timer.current), []);
  const show = useCallback(() => {
    cancel();
    setPopped(true);
  }, [cancel]);
  const tuck = useCallback(() => {
    cancel();
    setPopped(false);
  }, [cancel]);
  // After a short delay, unless the pointer came back or the keyboard is in it.
  const tuckSoon = useCallback(() => {
    cancel();
    timer.current = window.setTimeout(() => {
      const el = side.current;
      if (el?.matches(":hover") || el?.querySelector(":focus-visible")) return;
      setPopped(false);
    }, TUCK_DELAY);
  }, [cancel]);

  // Docked, there is nothing to pop out; and no timer outlives the shell.
  useEffect(() => {
    if (!hidden) tuck();
  }, [hidden, tuck]);
  useEffect(() => cancel, [cancel]);

  return { popped: hidden && popped, side, show, tuck, tuckSoon, cancel };
}

/** The thin strip at the window's left edge that wakes a hidden sidebar. It
    opts out of the window drag region so the pointer events reach it. */
export function SidebarHotZone({
  onEnter,
  onLeave,
}: {
  onEnter: () => void;
  onLeave: () => void;
}) {
  return (
    <div
      aria-hidden
      data-sidebar-hot-zone
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      className="absolute inset-y-0 left-0 z-30 w-1.5 [-webkit-app-region:no-drag]"
    />
  );
}
