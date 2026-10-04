import { CircleAlertIcon } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import type { Toast } from "./toast";

/* The one-line notice host, rendered once by the app shell. It floats
   above whatever bottom-anchored block the screen shows — every composer
   carries `data-composer` and the gap is measured, so the pill never
   lands on the toolbar row's controls no matter how tall the trays grow
   (#423 review: a bare `bottom-5` covered the model chip). With no
   composer on screen it settles back to the plain bottom offset. */
const RESTING_PX = 20;
const GAP_PX = 12;

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
      setBottom(px);
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of document.querySelectorAll("[data-composer]"))
      ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  return (
    <div
      data-toast
      role="status"
      style={{ bottom }}
      className="fixed left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-lg border bg-popover px-4 py-2 text-popover-foreground text-sm shadow-lg backdrop-blur"
    >
      {toast.error && (
        <CircleAlertIcon className="size-4 shrink-0 text-destructive" />
      )}
      <span className="min-w-0">{toast.text}</span>
    </div>
  );
}
