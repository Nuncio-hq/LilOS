import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";

/**
 * #512: a held (stubbed) turn row carries no text nodes (#430), so browser
 * find-in-page can't match inside it. A find chord — Cmd/Ctrl+F,
 * Cmd/Ctrl+G (find next/prev) or F3 — opens a ~10 s window in which every
 * held row mounts its real content so find lands; each chord re-arms the
 * window and rows re-stub when it lapses. The chord is only observed,
 * never consumed: the browser's own find bar must still open.
 *
 * apps/desktop has no app-level find (Electron's editMenu role carries no
 * Find item, nothing calls `webContents.findInPage`), so this window-level
 * keydown path is the only one to hook — and it rides in packages/ui so
 * the prototype and apps/web share it.
 */

export const FIND_UNSTUB_MS = 10_000;

/* e2e/dev knob — `?findUnstubMs=` shortens the window (same pattern as
   `?statusPollMs=` in apps/web/src/lib/config.ts) so a spec can prove the
   DOM re-bounds without a real 10 s wait. Read once at module load. */
const windowMs = (() => {
  if (typeof window === "undefined") return FIND_UNSTUB_MS;
  const v = Number(
    new URLSearchParams(window.location.search).get("findUnstubMs"),
  );
  return Number.isFinite(v) && v > 0 ? v : FIND_UNSTUB_MS;
})();

/* e2e/dev knob — `?findUnstubNudge=<px>` displaces the scrollport's
   scrollTop up by <px> while a find window is open, modelling the
   scroll-anchor drift a mount/re-stub cycle can produce (#537). Read
   once at module load. */
export const FIND_UNSTUB_NUDGE_PX = (() => {
  if (typeof window === "undefined") return 0;
  const v = Number(
    new URLSearchParams(window.location.search).get("findUnstubNudge"),
  );
  return Number.isFinite(v) && v > 0 ? v : 0;
})();

const listeners = new Set<() => void>();
let active = false;
let timer: ReturnType<typeof setTimeout> | undefined;

const emit = () => {
  for (const l of listeners) l();
};

/** A find chord landed: open the un-stub window, or re-arm it. */
function noteFindChord() {
  const was = active;
  active = true;
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    active = false;
    emit();
  }, windowMs);
  if (!was) emit();
}

const isFindChord = (e: KeyboardEvent) => {
  if (e.key === "F3") return true;
  if (!e.metaKey && !e.ctrlKey) return false;
  const k = e.key.toLowerCase();
  return k === "f" || k === "g";
};

const onKeyDown = (e: KeyboardEvent) => {
  if (isFindChord(e)) noteFindChord();
};

/* Subscribing mounts the one shared listener — capture phase so a field's
   own keydown handler can't shadow the chord; the last unsubscribe drops
   it again. Only lazy threads subscribe (LazyShell gates on `lazy`), so
   short threads never pay for this. */
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1 && typeof window !== "undefined")
    window.addEventListener("keydown", onKeyDown, true);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      if (typeof window !== "undefined")
        window.removeEventListener("keydown", onKeyDown, true);
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      active = false;
    }
  };
}

const noopSubscribe = () => () => {};

/** True while the find window is open — LazyShell reads it to keep every
    row mounted. A row in a short thread (`engaged` false) never subscribes
    and never mounts the keydown listener. */
export function useFindUnstub(engaged: boolean): boolean {
  return useSyncExternalStore(
    engaged ? subscribe : noopSubscribe,
    () => active,
    () => false,
  );
}

/** #537: renders inside <Conversation>. With `?findUnstubNudge=<px>` set,
    each opened find window displaces the port's scrollTop up by <px> —
    through stick-to-bottom's own state setter, so the write rides the
    ignoreScrollToTop path and reads as neither a user escape nor a
    resize. The spec then proves the lapse leaves the port wherever the
    drift put it: the cycle itself must never move the reader's place. */
export function FindUnstubNudge(): null {
  const { state } = useStickToBottomContext();
  const open = useFindUnstub(FIND_UNSTUB_NUDGE_PX > 0);
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      state.scrollTop = Math.max(0, state.scrollTop - FIND_UNSTUB_NUDGE_PX);
    });
    return () => cancelAnimationFrame(id);
  }, [open, state]);
  return null;
}

/** #537: renders inside <Conversation>. A find window mounts every held
    row and re-stubs them when it lapses — the mass DOM swap can move the
    scrollport: the bottom pin's spring re-fires on any content resize
    (and a spring in flight keeps crawling through the window), and the
    browser's own scroll anchor wanders when its tracked node is swapped.
    On the open edge — a layout effect, so it lands before the commit's
    paint and before the next spring tick — the row under the port's top
    edge and its offset are captured and both movers suspended; on the
    lapse the anchor is re-applied every frame until the re-stub settles,
    then the pin re-arms. Cmd+F then waiting never moves the reader's
    place. */
export function FindUnstubAnchor({ lazy }: { lazy: boolean }): null {
  const { scrollRef, state } = useStickToBottomContext();
  const open = useFindUnstub(lazy);
  const pinned = useRef(false);
  const anchor = useRef<{
    el: Element | null;
    offset: number;
    top: number;
  } | null>(null);

  useLayoutEffect(() => {
    const port = scrollRef.current;
    if (!open || !port) return;
    pinned.current = state.isAtBottom;
    state.isAtBottom = false;
    port.style.overflowAnchor = "none";
    const pt = port.getBoundingClientRect();
    const top = state.scrollTop;
    anchor.current = { el: null, offset: 0, top };
    for (const row of port.querySelectorAll("[data-msg]")) {
      const r = row.getBoundingClientRect();
      if (r.bottom > pt.top) {
        anchor.current = { el: row, offset: r.top - pt.top, top };
        break;
      }
    }
  }, [open, scrollRef, state]);

  useEffect(() => {
    if (open) return;
    const a = anchor.current;
    const port = scrollRef.current;
    if (!a || !port) return;
    anchor.current = null;
    let calm = 0;
    let frames = 0;
    let cancelled = false;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      port.style.overflowAnchor = "";
      if (pinned.current && !state.escapedFromLock) state.isAtBottom = true;
      pinned.current = false;
    };
    const fix = () => {
      if (cancelled) return;
      if (frames++ > 120 || calm > 5) {
        finish();
        return;
      }
      const delta =
        a.el && a.el.isConnected
          ? a.el.getBoundingClientRect().top -
            port.getBoundingClientRect().top -
            a.offset
          : a.top - state.scrollTop;
      if (Math.abs(delta) > 0.5) {
        state.scrollTop = state.scrollTop + delta;
        calm = 0;
      } else {
        calm += 1;
      }
      requestAnimationFrame(fix);
    };
    const id = requestAnimationFrame(fix);
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
      finish();
    };
  }, [open, scrollRef, state]);
  return null;
}
