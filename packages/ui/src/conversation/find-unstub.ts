import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  type StickToBottomState,
  useStickToBottomContext,
} from "use-stick-to-bottom";
import { ConversationPin } from "../components/ai-elements/conversation";

/**
 * #512: a held (stubbed) turn row carries no text nodes (#430), so browser
 * find-in-page can't match inside it. A find chord — Cmd/Ctrl+F,
 * Cmd/Ctrl+G (find next/prev) or F3 — opens a ~10 s window in which every
 * held row mounts its real content so find lands; each chord re-arms the
 * window and rows re-stub when it lapses. The chord is only observed,
 * never consumed: the browser's own find bar must still open.
 *
 * apps/desktop's own find bar (#554) pins the window for its whole find
 * session via `setFindSessionOpen` — held rows stay findable while the
 * bar is open — and the window-level chord listener stays as the
 * fallback for platforms where the browser's own find owns the keys.
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

/* e2e/dev knob — `?findUnstubNudge=<px>` shifts the scrollport's
   scrollTop up by <px> once the open mount has settled, modelling the
   browser find bar hopping to a match mid-window (#537). Read once at
   module load. */
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
/* #554: an app-level find UI (the Electron find bar) pins the window for
   its whole find session — held rows stay mounted and findable while the
   bar is open, instead of re-stubbing 10 s after the last chord. */
let pinned = false;

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
    /* A pinned find session outlives the lapse — a chord mid-session
       re-arms the window but must not un-mount the rows (#554). */
    if (pinned) return;
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
      /* A pinned find session dies with its last lazy thread — re-opening
         must mount rows again, not early-return on a stale flag (#554). */
      pinned = false;
    }
  };
}

/** Pin (or release) the un-stub window for an app-level find session
    (#554). Opening mounts every held row and keeps them mounted; closing
    hands the session back to the ordinary lapse — the anchor then
    re-stubs at wherever the reader's find jump left them. */
export function setFindSessionOpen(open: boolean): void {
  if (open === pinned) return;
  pinned = open;
  if (open) {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!active) {
      active = true;
      emit();
    }
  } else {
    noteFindChord();
  }
}

const noopSubscribe = () => () => {};

/** Peek at the window without subscribing — for the escape guard's
    overflow-anchor handoff (#570), which must not mount the keydown
    listener on ports that aren't lazy. */
export const findUnstubOpen = () => active;

/* #570: the conversation escape guard also manages the port's
   overflow-anchor while the bottom pin holds — but while a find hold is
   mid-swap the flag is THIS module's (open edge or lapse hold, both need
   anchoring off while they correct scrollTop). Counted per port (keyed
   on the stick state) so two Conversations can't mask each other. */
const anchorHolds = new WeakMap<object, number>();
const trackAnchorHold = (state: object, delta: number) =>
  anchorHolds.set(state, (anchorHolds.get(state) ?? 0) + delta);
/** True while a find window or a find hold owns the port's
    overflow-anchor — the escape guard must not restore it mid-swap. */
export const findAnchorActive = (state: object) =>
  findUnstubOpen() || (anchorHolds.get(state) ?? 0) > 0;

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

/* The row under the port's top edge and its offset below that edge —
   enough to put it back pixel-exact after a mass swap. The outer
   [data-msg] div persists across a stub↔content swap, so the captured
   element stays valid through it. */
interface EdgeAnchor {
  el: Element | null;
  offset: number;
  top: number;
}

const captureTopEdge = (port: HTMLElement): EdgeAnchor => {
  const pt = port.getBoundingClientRect();
  const top = port.scrollTop;
  for (const row of port.querySelectorAll("[data-msg]")) {
    const r = row.getBoundingClientRect();
    if (r.bottom > pt.top) return { el: row, offset: r.top - pt.top, top };
  }
  return { el: null, offset: 0, top };
};

/* Per-Conversation handshake between the anchor's open-edge hold and the
   nudge knob — keyed on the stick-to-bottom `state` object, which is
   stable for the instance. A find-bar jump can only land once the mount
   it triggered has settled: the nudge waits on `holding`, and falls back
   to next frame when no hold is running (a non-lazy port never opens
   one). */
interface HoldGate {
  holding: boolean;
  waiters: Set<() => void>;
}
const holdGates = new WeakMap<object, HoldGate>();
const holdGate = (state: object): HoldGate => {
  let g = holdGates.get(state);
  if (!g) {
    g = { holding: false, waiters: new Set() };
    holdGates.set(state, g);
  }
  return g;
};

/* Re-apply a captured edge anchor every frame until the swap it belongs
   to has landed and gone calm: `settled(frames)` reports the swap (the
   mount's stubs clearing, the lapse's first stub re-appearing) or gives
   up waiting, then five consecutive |delta| ≤ 0.5 frames release the
   hold. Corrections ride stick-to-bottom's scrollTop setter so they use
   the ignoreScrollToTop path — never a reader escape. Returns a cancel
   that also releases. */
function holdTopEdge(
  port: HTMLElement,
  state: StickToBottomState,
  anchor: EdgeAnchor,
  settled: (frames: number) => boolean,
  onRelease: () => void,
): () => void {
  let calm = 0;
  let frames = 0;
  let cancelled = false;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    onRelease();
  };
  const fix = () => {
    if (cancelled) return;
    frames += 1;
    const delta = anchor.el?.isConnected
      ? anchor.el.getBoundingClientRect().top -
        port.getBoundingClientRect().top -
        anchor.offset
      : anchor.top - port.scrollTop;
    if (Math.abs(delta) > 0.5) {
      state.scrollTop = state.scrollTop + delta;
      calm = 0;
    } else if (settled(frames)) {
      calm += 1;
    }
    if (frames > 180 || calm > 5) {
      release();
      return;
    }
    requestAnimationFrame(fix);
  };
  const id = requestAnimationFrame(fix);
  return () => {
    cancelled = true;
    cancelAnimationFrame(id);
    release();
  };
}

/** #537 e2e/dev knob — renders inside <Conversation>. With
    `?findUnstubNudge=<px>` set, each opened find window shifts the port's
    scrollTop up by <px> once the open-edge hold releases: the browser
    find bar can't jump to a match before the mount that un-stubbed it.
    The write is the RAW scrollTop — like the find bar's own scroll it
    rides the real scroll-event path, escaping the bottom pin (the ↓
    button mounts). The spec then proves the lapse leaves the port at the
    JUMPED position: a mid-window scroll is the reader's and stands. */
export function FindUnstubNudge(): null {
  const { scrollRef, state } = useStickToBottomContext();
  const pin = useContext(ConversationPin);
  const open = useFindUnstub(FIND_UNSTUB_NUDGE_PX > 0);
  useEffect(() => {
    if (!open) return;
    let done = false;
    const fire = () => {
      if (done) return;
      done = true;
      const port = scrollRef.current;
      if (port) {
        /* The nudge IS the reader-sim: the escape guard excludes hold-
           window writes from its scrollTop patch (hold corrections ride
           the same setter), so mark the intent directly — the jumped
           position is the reader's and must stand after the window. */
        if (pin) pin.escaped.v = true;
        port.scrollTop = Math.max(0, port.scrollTop - FIND_UNSTUB_NUDGE_PX);
        /* The post-write position is the spec's ground truth: under #570's
           estimated stubs the pre-window top drifts while the mount holds
           the view, so "did the jump land" must read where the write
           landed, not the pre-chord scrollTop. */
        (
          window as unknown as { __findUnstubNudged?: number }
        ).__findUnstubNudged = port.scrollTop;
      }
    };
    const gate = holdGate(state);
    if (gate.holding) {
      gate.waiters.add(fire);
      return () => gate.waiters.delete(fire);
    }
    const id = requestAnimationFrame(fire);
    return () => cancelAnimationFrame(id);
  }, [open, scrollRef, state]);
  return null;
}

/** #537: renders inside <Conversation>. A find window mounts every held
    row and re-stubs them when it lapses — two mass DOM swaps that can
    move the scrollport (the bottom pin's spring re-fires on content
    resize, a spring in flight keeps crawling, and the browser's own
    scroll anchor wanders when its tracked node is swapped). Each swap is
    anchored at ITS OWN edge:

    - open: the row under the port's top edge is captured in a layout
      effect — before the mount commit can paint — and held until the
      mount settles. Opening the window must not move the view.
    - while the window is open nothing here writes scrollTop: a find-bar
      jump or wheel scroll is the reader's and stands.
    - lapse: the row under the top edge is captured again — wherever the
      reader is NOW — and held until the re-stub settles. The lapse must
      not move the view either.
    - the bottom pin is suspended for the whole window and re-arms only
      if the port is at the bottom at lapse time; what it was at open is
      irrelevant once the reader has jumped. */
export function FindUnstubAnchor({ lazy }: { lazy: boolean }): null {
  const { scrollRef, state } = useStickToBottomContext();
  const open = useFindUnstub(lazy);
  const wasOpen = useRef(false);

  useLayoutEffect(() => {
    const port = scrollRef.current;
    if (!port) return;
    if (open) {
      /* OPEN edge — the stubs are still in place in this commit's DOM
         (the mount lands in the next one), so the captured row/offset is
         the reader's exact pre-mount view. */
      state.isAtBottom = false;
      port.style.overflowAnchor = "none";
      wasOpen.current = true;
      const gate = holdGate(state);
      gate.holding = true;
      trackAnchorHold(state, +1);
      return holdTopEdge(
        port,
        state,
        captureTopEdge(port),
        (frames) => frames > 30 || !port.querySelector("[data-held-stub]"),
        () => {
          trackAnchorHold(state, -1);
          gate.holding = false;
          for (const f of gate.waiters) f();
          gate.waiters.clear();
        },
      );
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    /* LAPSE edge — capture where the reader is NOW, the moment the
       window lapses, then hold through the re-stub swap. */
    trackAnchorHold(state, +1);
    return holdTopEdge(
      port,
      state,
      captureTopEdge(port),
      (frames) => frames > 30 || !!port.querySelector("[data-held-stub]"),
      () => {
        trackAnchorHold(state, -1);
        port.style.overflowAnchor = "";
        /* Re-pin only if the port is at the bottom at lapse time — the
           library's lock target is scrollHeight − 1 − clientHeight and
           "at the bottom" is within 2 px (same convention as ac-535). */
        const atBottom =
          port.scrollHeight - port.scrollTop - port.clientHeight <= 2;
        if (atBottom) {
          state.escapedFromLock = false;
          state.isAtBottom = true;
        }
      },
    );
  }, [open, scrollRef, state]);
  return null;
}
