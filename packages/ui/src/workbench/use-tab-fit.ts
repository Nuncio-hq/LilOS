import { useEffect, useLayoutEffect, useRef } from "react";
import type { WbTab } from "../types";

/* When the strip runs out of room, labels fold to icons least-used first —
   the situational tabs (Background, Details, Subagents, Plan, PR) before the
   working set (Files, Preview, Terminal, Changes). The active tab always
   keeps its label; only when even icons overflow does the strip scroll
   (issue #326). */
const COMPACT_ORDER: WbTab[] = [
  "background",
  "details",
  "subagents",
  "plan",
  "pr",
  "preview",
  "browser",
  "files",
  "terminal",
  "changes",
];

/** Fold/scroll fit for the strip (issue #326): when it can't show every
    label, tabs fold to icon + count — least-used first, the active tab
    never. When even all-icons overflows, the strip scrolls left-anchored
    with an edge fade and the active tab scrolls into view. Fold/scroll apply
    imperatively inside this layout pass (`.wb-fold` class + a11y attrs, mask
    on the list), so no intermediate committed frame can carry a clipped tab.
    Returns the ref for the `TabsList`. */
export function useTabFit(shownTab: WbTab | undefined) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const stepRef = useRef<() => void>(() => {});
  const maskRef = useRef<() => void>(() => {});
  /* Attached once, the first time the list exists — re-created only if the
     list element itself is replaced. */
  const fitRef = useRef<{
    ro: ResizeObserver;
    el: HTMLElement;
    onScroll: () => void;
  } | null>(null);
  /* Each tab's label width + its flex gap, cached while expanded — folding a
     tab saves exactly its own measured label. */
  const labelsRef = useRef(new Map<WbTab, number>());
  /* Scroll-into-view fires on entering scroll mode or switching the active
     tab — not on every layout pass, so a manual scroll isn't snapped back. */
  const scrolledForRef = useRef<WbTab | null>(null);
  useLayoutEffect(() => {
    const el = listRef.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const px = (s: string) => {
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : 0;
    };
    /* Fade whichever edge hides overflowed tabs; solid where content fits. */
    const updateMask = () => {
      if (!el.classList.contains("wb-scroll")) {
        el.style.maskImage = "";
        return;
      }
      const l = el.scrollLeft > 2;
      const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      const stops: string[] = l ? ["transparent", "#000 24px"] : ["#000 24px"];
      stops.push(`#000 calc(100% - ${r ? 24 : 0}px)`);
      if (r) stops.push("transparent");
      el.style.maskImage = `linear-gradient(to right, ${stops.join(", ")})`;
    };
    const step = () => {
      const trigs = new Map<WbTab, HTMLElement>();
      for (const t of el.querySelectorAll<HTMLElement>("[data-wb-tab]"))
        if (t.dataset.wbTab) trigs.set(t.dataset.wbTab as WbTab, t);
      const labels = labelsRef.current;
      for (const [t, trg] of trigs) {
        const sp = trg.querySelector<HTMLElement>("[data-wb-label]");
        if (sp && sp.offsetWidth > 0) labels.set(t, sp.offsetWidth + 6);
      }
      const widthOf = (t: WbTab, folded: boolean) => {
        const trg = trigs.get(t)!;
        const lw = labels.get(t) ?? 60;
        const full = trg.classList.contains("wb-fold")
          ? trg.offsetWidth + lw
          : trg.offsetWidth;
        return folded ? full - lw : full;
      };
      const ps = getComputedStyle(parent);
      const ls = getComputedStyle(el);
      /* Free room the strip may still grow into: the parent's content box
         minus siblings (the close button), gaps, and the list's own chrome —
         padding included, which is what the triggers' content box sees. */
      const avail =
        parent.clientWidth -
        px(ps.paddingLeft) -
        px(ps.paddingRight) -
        px(ps.columnGap) * (parent.children.length - 1) -
        [...parent.children].reduce(
          (w, c) => (c === el ? w : w + (c as HTMLElement).offsetWidth),
          0,
        ) -
        (el.offsetWidth - el.clientWidth) -
        px(ls.paddingLeft) -
        px(ls.paddingRight);
      let total =
        [...trigs.keys()].reduce((w, t) => w + widthOf(t, false), 0) +
        px(ls.columnGap) * Math.max(trigs.size - 1, 0);
      const next = new Set<WbTab>();
      for (const t of COMPACT_ORDER) {
        if (total <= avail + 1) break;
        if (t === shownTab || !trigs.has(t)) continue;
        next.add(t);
        total -= widthOf(t, false) - widthOf(t, true);
      }
      const fits = total <= avail + 1;
      el.classList.toggle("wb-scroll", !fits);
      updateMask();
      for (const [t, trg] of trigs) {
        const fold = next.has(t);
        trg.classList.toggle("wb-fold", fold);
        const name = trg.dataset.wbName ?? "";
        if (fold) {
          /* aria-label replaces the subtree — keep the visible count in it. */
          const badge = trg.querySelector<HTMLElement>(
            "[data-bg-running],[data-subagents-running]",
          );
          trg.setAttribute(
            "aria-label",
            badge ? `${name} ${badge.textContent?.trim()}` : name,
          );
          trg.title = name;
        } else {
          trg.removeAttribute("aria-label");
          trg.removeAttribute("title");
        }
      }
      /* Scroll mode: keep the active tab in view — on entering scroll or on
         tab switch only, so a manual scroll sticks. */
      if (!fits && shownTab) {
        if (scrolledForRef.current !== shownTab) {
          trigs
            .get(shownTab)
            ?.scrollIntoView({ inline: "nearest", block: "nearest" });
          scrolledForRef.current = shownTab;
        }
      } else {
        scrolledForRef.current = null;
      }
    };
    stepRef.current = step;
    maskRef.current = updateMask;
    step();
    if (fitRef.current?.el !== el) {
      fitRef.current?.ro.disconnect();
      fitRef.current?.el.removeEventListener("scroll", fitRef.current.onScroll);
      const onScroll = () => maskRef.current();
      const ro = new ResizeObserver(() => stepRef.current());
      ro.observe(parent);
      ro.observe(el);
      el.addEventListener("scroll", onScroll);
      fitRef.current = { ro, el, onScroll };
    }
  });
  useEffect(
    () => () => {
      fitRef.current?.ro.disconnect();
      fitRef.current?.el.removeEventListener("scroll", fitRef.current.onScroll);
      fitRef.current = null;
    },
    [],
  );
  return listRef;
}
