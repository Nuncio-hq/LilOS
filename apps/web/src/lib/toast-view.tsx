import { CircleAlertIcon } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Toast } from "./toast";

/* The one-line notice host, rendered once by the app shell. It floats
   above whatever bottom-anchored block the screen shows — every composer
   carries `data-composer` and the gap is measured, so the pill never
   lands on the toolbar row's controls no matter how tall the trays grow
   (#423 review: a bare `bottom-5` covered the model chip). With no
   composer on screen it settles back to the plain bottom offset. It is
   portaled to <body> because the app frame's backdrop-filter makes it a
   stacking context: an in-tree z-index could never outrank the popover
   portal (model picker's card sits at z-50 there). */
const RESTING_PX = 20;
const GAP_PX = 12;
/* A dock taller than the viewport could push the pill off the top edge —
   keep at least this much of it on screen. */
const TOP_RESERVE_PX = 56;

export function ToastView({ toast }: { toast: Toast }) {
  const [bottom, setBottom] = useState(RESTING_PX);
  useLayoutEffect(() => {
    const measure = () => {
      let px = RESTING_PX;
      for (const el of document.querySelectorAll("[data-composer]")) {
        const r = el.getBoundingClientRect();
        if (r.height > 0)
          px = Math.max(px, window.innerHeight - r.top + GAP_PX);
      }
      setBottom(Math.min(px, window.innerHeight - TOP_RESERVE_PX));
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
  }, []);
  return createPortal(
    <div
      data-toast
      role="status"
      style={{ bottom }}
      className="fixed left-1/2 z-[60] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-lg border bg-popover px-4 py-2 text-popover-foreground text-sm shadow-lg backdrop-blur"
    >
      {toast.error && (
        <CircleAlertIcon className="size-4 shrink-0 text-destructive" />
      )}
      <span className="min-w-0 break-words">{toast.text}</span>
    </div>,
    document.body,
  );
}
