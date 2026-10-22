import { CircleAlertIcon } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

/* The one-line notice host, rendered once by the app shell and by the
   prototype (the same pill in both). It floats above whatever bottom-anchored
   block the screen shows — every composer carries `data-composer` and the gap
   is measured, so the pill never lands on the toolbar row's controls no matter
   how tall the trays grow (#423 review: a bare `bottom-5` covered the model
   chip). With no composer on screen it settles back to the plain bottom
   offset. It is portaled to <body> because the app frame's backdrop-filter
   makes it a stacking context: an in-tree z-index could never outrank the
   popover portal (model picker's card sits at z-50 there). */
const RESTING_PX = 20;
const GAP_PX = 12;
/* A dock taller than the viewport could push the pill off the top edge —
   keep at least this much of it on screen. */
const TOP_RESERVE_PX = 56;

/** What the pill says; the host decides how long it stays. */
export interface ToastNotice {
  text: string;
  /** Failures carry a destructive accent (#423); absent = a neutral note. */
  error?: boolean;
  /** A single action the notice offers — "Undo" on a rewind (#578). */
  action?: { label: string; run: () => void };
}

export function ToastView({
  toast,
  anchor,
}: {
  toast: ToastNotice;
  /** The panel this notice belongs to. Set, the pill is centred in that
      panel instead of the window, so it does not sit across the seam
      between the page and the side peek. Absent: the window, as before. */
  anchor?: HTMLElement | null;
}) {
  const [place, setPlace] = useState<{ bottom: number; left?: number }>({
    bottom: RESTING_PX,
  });
  useLayoutEffect(() => {
    if (anchor) {
      /* The panel is the frame. A composer on the other side of the seam
         must not pull the pill back to the middle of the window. */
      const measure = () => {
        const r = anchor.getBoundingClientRect();
        const visibleBottom = Math.min(
          Math.max(r.bottom, 0),
          window.innerHeight,
        );
        const visibleTop = Math.max(r.top, 0);
        const maxBottom = Math.max(
          GAP_PX,
          window.innerHeight - visibleTop - TOP_RESERVE_PX,
        );
        const bottom = Math.min(
          Math.max(window.innerHeight - visibleBottom + GAP_PX, GAP_PX),
          maxBottom,
        );
        setPlace({ bottom, left: r.left + r.width / 2 });
      };
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(anchor);
      window.addEventListener("resize", measure);
      window.addEventListener("scroll", measure, true);
      return () => {
        ro.disconnect();
        window.removeEventListener("resize", measure);
        window.removeEventListener("scroll", measure, true);
      };
    }
    const measure = () => {
      let px = RESTING_PX;
      for (const el of document.querySelectorAll("[data-composer]")) {
        const r = el.getBoundingClientRect();
        if (r.height > 0)
          px = Math.max(px, window.innerHeight - r.top + GAP_PX);
      }
      setPlace({
        bottom: Math.min(px, window.innerHeight - TOP_RESERVE_PX),
      });
    };
    const ro = new ResizeObserver(measure);
    /* Composers mount and unmount while a toast is alive (DM home → Focus
       mid-flight), so watch the tree — an element that wasn't here on
       mount still gets measured, same seam watchDragRegions uses. The
       filter keeps unrelated churn (streamed tokens) from re-measuring. */
    const refresh = () => {
      for (const el of document.querySelectorAll("[data-composer]"))
        ro.observe(el);
      measure();
    };
    refresh();
    const mo = new MutationObserver((muts) => {
      const hit = muts.some((m) =>
        [...m.addedNodes, ...m.removedNodes].some(
          (n) =>
            n instanceof Element &&
            (n.closest("[data-composer]") != null ||
              n.querySelector("[data-composer]") != null),
        ),
      );
      if (hit) refresh();
    });
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", measure);
    return () => {
      mo.disconnect();
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [anchor]);
  return createPortal(
    <div
      data-toast
      data-toast-panel={anchor ? "" : undefined}
      role="status"
      style={
        place.left === undefined
          ? { bottom: place.bottom }
          : { bottom: place.bottom, left: place.left }
      }
      className={`fixed z-[60] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-lg border bg-popover px-4 py-2 text-popover-foreground text-sm shadow-lg backdrop-blur ${place.left === undefined ? "left-1/2" : ""}`}
    >
      {toast.error && (
        <CircleAlertIcon className="size-4 shrink-0 text-destructive" />
      )}
      <span className="min-w-0 break-words">{toast.text}</span>
      {toast.action && (
        <button
          type="button"
          data-toast-action
          onClick={toast.action.run}
          className="shrink-0 font-medium text-primary underline-offset-2 hover:underline"
        >
          {toast.action.label}
        </button>
      )}
    </div>,
    document.body,
  );
}
