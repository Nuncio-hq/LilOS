import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { clamp } from "./v3-layout-prefs";

const STEP = 16;
const BIG_STEP = 64;

/** An element's width, kept current as the window changes. A callback ref, not
    an object: the element may mount later than the hook (the shell draws
    Welcome first, then the frame). 0 until measured, and always in a bare DOM
    with no layout — callers then skip their limits. */
export function useWidth() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    const sync = () => setWidth(el.getBoundingClientRect().width);
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width] as const;
}

/* A divider you can drag: pointer capture keeps the drag alive when the
   pointer leaves the thin hit area or crosses an iframe. The hairline is the
   panel's own border; on hover or drag it thickens so the handle announces
   itself. Double-click resets, and as a `separator` with a value it works
   from the keyboard: ←/→ move it, Home/End jump to the limits. */
export function ResizeHandle({
  label,
  value,
  min,
  max,
  grows,
  edge,
  onChange,
  onReset,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Which way the pointer moves to widen the panel: a sidebar on the left
      widens by going right, the peek on the right by going left. */
  grows: "right" | "left";
  /** Whether the panel whose border this is comes before the handle (the
      sidebar) or after it (the peek). */
  edge: "before" | "after";
  onChange: (width: number) => void;
  onReset: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, w: 0 });
  const sign = grows === "right" ? 1 : -1;
  // A drag across the page must not select its text.
  useEffect(() => {
    if (!dragging) return;
    const prev = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.userSelect = prev;
    };
  }, [dragging]);
  const move = (w: number) => onChange(clamp(w, min, max));

  return (
    <div className="relative z-30 w-0 shrink-0">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={Math.round(value)}
        aria-valuemin={Math.round(min)}
        aria-valuemax={Math.round(max)}
        tabIndex={0}
        title="Drag to resize, double-click to reset"
        data-dragging={dragging || undefined}
        className="group absolute inset-y-0 -left-[4px] w-[9px] cursor-col-resize touch-none outline-none"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          start.current = { x: e.clientX, w: value };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (dragging)
            move(start.current.w + sign * (e.clientX - start.current.x));
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onDoubleClick={onReset}
        onKeyDown={(e) => {
          const step = e.shiftKey ? BIG_STEP : STEP;
          const dir =
            e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
          if (dir !== 0) move(value + dir * sign * step);
          else if (e.key === "Home") move(min);
          else if (e.key === "End") move(max);
          else return;
          e.preventDefault();
        }}
      >
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-y-0 w-px bg-transparent transition-[width,background-color] duration-100 group-hover:w-[3px] group-hover:bg-foreground/25 group-focus-visible:w-[3px] group-focus-visible:bg-foreground/40 group-data-[dragging]:w-[3px] group-data-[dragging]:bg-foreground/40",
            // The panel's own 1px border sits just before or after the
            // handle's centre line; the line sits on it and thickens from it.
            edge === "before" ? "left-[3px]" : "left-[4px]",
          )}
        />
      </div>
    </div>
  );
}
