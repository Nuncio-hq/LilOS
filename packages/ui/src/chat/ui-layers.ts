import { useCallback, useEffect, useRef } from "react";
import { OPEN_OVERLAY } from "./composer-keys";

/* Mount-ordered stack of UI surfaces that own keyboard input (issue #576).
   Esc dispatches to the top-most layer only — menu → dialog → panel → Focus
   by mount order — so it always closes something and can never leak through
   to a second surface or stop a turn. A surface with its own overlay element
   (a dialog) registers it so the overlay check can tell OUR dialogs apart
   from foreign overlays (Base UI popovers/menus/vendored dialogs), which keep
   owning Esc themselves. */
export interface UiLayerHandlers {
  /** Esc pressed while this layer is top-most — typically onClose/onBack. */
  onEscape?: () => void;
  /** Non-Escape keys while this layer is top-most; return true = consumed. */
  onKey?: (e: KeyboardEvent) => boolean | void;
}

interface Layer extends UiLayerHandlers {
  el?: HTMLElement;
}

const stack: Layer[] = [];
let listening = false;

/** A matching overlay element that no registered layer owns — the composer's
 *  `@` menu, a Base UI popover/select, a vendored dialog. Those components
 *  handle Esc internally; the stack must not eat their key. */
function foreignOverlayOpen(): boolean {
  for (const el of document.querySelectorAll(OPEN_OVERLAY))
    /* Only a visible, unowned overlay is foreign — Base UI keeps closed
       menus/popovers mounted while they animate out, and counting them
       would swallow Esc meant for the layer underneath. */
    if (
      (el as HTMLElement).checkVisibility({ checkVisibilityCSS: true }) &&
      !stack.some((l) => l.el === el)
    )
      return true;
  return false;
}

function dispatch(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === "Escape") {
    if (foreignOverlayOpen()) return;
    if (top.onEscape) {
      e.preventDefault();
      top.onEscape();
    }
    return;
  }
  if (top.onKey?.(e) === true) e.preventDefault();
}

function ensureListener() {
  if (listening) return;
  listening = true;
  window.addEventListener("keydown", dispatch, true);
}

function push(layer: Layer) {
  stack.push(layer);
  ensureListener();
}

function remove(layer: Layer) {
  const i = stack.indexOf(layer);
  if (i >= 0) stack.splice(i, 1);
}

/* Keep the registered record pointing at this render's handlers. It must
   assign onto the stable layer object itself, not ref.current: StrictMode's
   effect remount runs the push cleanup (which once nulled the ref) before
   the re-assign, so a ref read could hit null or a stale replacement and
   leave the pushed layer handler-less. */
function useLatest(layer: Layer, h: UiLayerHandlers) {
  useEffect(() => {
    Object.assign(layer, h);
  });
}

/**
 * A conceptual layer — the thread panel, Focus view — that owns Esc and
 * surface keys while top-most but has no overlay element of its own.
 */
export function useUiLayer(handlers: UiLayerHandlers): void {
  /* The layer object is created in render (not the mount effect) so
     useLatest's first pass already lands the handlers on it — otherwise
     the pushed record stays empty until a second render. */
  const ref = useRef<Layer | null>(null);
  if (ref.current === null) ref.current = {};
  const layer = ref.current;
  useLatest(layer, handlers);
  useEffect(() => {
    push(layer);
    return () => remove(layer);
  }, [layer]);
}

/**
 * A layer bound to its dialog root element. Attach the returned ref to the
 * element carrying `role="dialog"` so the overlay check never treats the
 * dialog's own root as foreign (which would swallow its Esc forever).
 */
export function useUiLayerEl<T extends HTMLElement = HTMLElement>(
  handlers: UiLayerHandlers,
): (el: T | null) => void {
  /* Push in the passive effect — same phase as useUiLayer — so stack order
     is mount order (ref callbacks run earlier and would invert siblings).
     The callback only stamps the layer's element so foreignOverlayOpen
     exempts it. */
  const ref = useRef<Layer | null>(null);
  if (ref.current === null) ref.current = {};
  const layer = ref.current;
  useLatest(layer, handlers);
  useEffect(() => {
    push(layer);
    return () => remove(layer);
  }, [layer]);
  return useCallback(
    (el: T | null) => {
      layer.el = el ?? undefined;
    },
    [layer],
  );
}
