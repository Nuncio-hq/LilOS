/**
 * Native macOS window chrome (issue #232): under the Electron preload
 * bridge, `<html>` carries `data-desktop` (traffic-light inset, drag
 * regions, sidebar vibrancy) and `data-fullscreen` while the window is in
 * native full screen — where macOS hides the lights, so the sidebar header
 * drops the inset it kept for them. A plain browser tab has no bridge and
 * is left untouched (AC-5). Returns an unsubscribe for tests.
 */
export function watchDesktopChrome(): () => void {
  const bridge = window.lilos;
  if (!bridge?.isDesktop) return () => {};
  const root = document.documentElement;
  root.setAttribute("data-desktop", "");
  const apply = (fullScreen: boolean) => {
    if (fullScreen) root.setAttribute("data-fullscreen", "");
    else root.removeAttribute("data-fullscreen");
  };
  apply(bridge.fullscreen?.current() ?? false);
  const off = bridge.fullscreen?.onChange(apply);
  return () => {
    off?.();
    root.removeAttribute("data-desktop");
    root.removeAttribute("data-fullscreen");
  };
}

/* Issue #301: the OS keeps its own draggable-region map for the frameless
   window, rebuilt only when the renderer re-pushes the `-webkit-app-region`
   rects. A `.lilos-drag` header that mounts (or gains/moves controls) while
   the cursor is already over it — the thread panel ⇄ Focus swap puts the
   Exit-focus button right under the pointer — can be left out of that map
   until a pointer event forces a recompute, so the click is swallowed as a
   window drag. Recompute on every relevant DOM change instead of waiting
   for the pointer: flip each strip's own app-region through a real two-frame
   diff (a same-task toggle can collapse to "unchanged" and push nothing).
   The sidebar header never hits this only because it exists at first paint,
   so its rects are in the initial map. */
export function watchDragRegions(): () => void {
  if (!window.lilos?.isDesktop) return () => {};
  if (
    typeof MutationObserver === "undefined" ||
    typeof ResizeObserver === "undefined"
  )
    return () => {};

  let pending = false;
  let flipping = false;
  const flip = () => {
    if (!pending) return;
    pending = false;
    flipping = true;
    const strips = document.querySelectorAll<HTMLElement>(".lilos-drag");
    for (const el of strips)
      el.style.setProperty("-webkit-app-region", "no-drag");
    requestAnimationFrame(() => {
      for (const el of strips) el.style.removeProperty("-webkit-app-region");
      flipping = false;
      if (pending) requestAnimationFrame(flip);
    });
  };
  const schedule = () => {
    pending = true;
    if (!flipping) requestAnimationFrame(flip);
  };

  const seen = new WeakSet<Element>();
  const ro = new ResizeObserver(schedule);
  const watchStrip = (el: Element) => {
    if (!seen.has(el)) {
      seen.add(el);
      ro.observe(el);
    }
  };

  const mo = new MutationObserver((muts) => {
    for (const el of document.querySelectorAll(".lilos-drag")) watchStrip(el);
    for (const m of muts) {
      let hit: boolean;
      if (m.type === "childList") {
        hit = [...m.addedNodes, ...m.removedNodes].some(
          (n) =>
            n instanceof Element &&
            (n.closest(".lilos-drag") != null ||
              n.querySelector(".lilos-drag") != null),
        );
      } else {
        hit =
          m.target instanceof Element &&
          m.target.closest(".lilos-drag") != null;
      }
      if (hit) {
        schedule();
        break;
      }
    }
  });
  // class/hidden attribute changes can move a control inside a strip; the
  // strips' own `style` changes stay unobserved so the nudge can't re-arm
  // itself.
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "hidden"],
  });
  for (const el of document.querySelectorAll(".lilos-drag")) watchStrip(el);

  return () => {
    mo.disconnect();
    ro.disconnect();
  };
}
