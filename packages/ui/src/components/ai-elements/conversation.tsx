"use client";

import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
} from "react";
import {
  type StickToBottomState,
  StickToBottom,
  useStickToBottomContext,
} from "use-stick-to-bottom";
import { findAnchorActive } from "../../conversation/find-unstub";

export type ConversationProps = ComponentProps<typeof StickToBottom> & {
  /* The port's pin object for callers that need to reach it before or
     outside the tree (thread/focus jump-to-hit) — assigned by the
     bridge, same shape as the ConversationPin context value. */
  pinRef?: RefObject<ConversationPin | null>;
};

/* #570: the pin the rows re-pin against — the library's live `state`
   plus two fields only this port's own machinery may set:
   - `hydratedAt` — performance.now() of the latest held→real commit; the
     escape guard treats the commits' wake (height churn, layout clamps)
     as layout noise for a quiet window after the last one.
   - `escaped` — the READER's intent, set only by input events (wheel-up,
     touch, nav keys) and decreasing JS scrollTop writes — never by the
     library's deferred flag flips, which a clamp can trip on a slow box. */
export interface ConversationPin {
  state: StickToBottomState;
  hydratedAt: { v: number };
  escaped: { v: boolean };
  /* Instant re-pin to the measured bottom: clears a stale clamp escape,
     kills any in-flight spring, and refreshes the React-side pin flags —
     everything the hydration commit edge needs in one call. */
  repin: () => void;
  /* Installed by the escape guard — optional because a commit can land
     before the guard's effect runs. */
  /* Record the current layout max so a later clamp event landing on it
     is fingerprinted as layout, not a reader. */
  noteMax?: () => void;
  /* True when the port sits on a clamp landing: the live bottom edge or
     a max recorded by an earlier commit — the dead-pin revive check. */
  isClampTop?: () => boolean;
  /* Re-arm the guard's bounded re-pin chain (each suspicious event or
     hydration commit refreshes it). */
  armReinstate?: () => void;
}

export const ConversationPin = createContext<ConversationPin | null>(null);

const ConversationPinBridge = ({
  children,
  pinRef,
}: {
  children: ReactNode;
  pinRef?: RefObject<ConversationPin | null>;
}) => {
  const { state, scrollToBottom } = useStickToBottomContext();
  const pin = useMemo<ConversationPin>(
    () => ({
      state,
      hydratedAt: { v: 0 },
      escaped: { v: false },
      repin: () => {
        state.escapedFromLock = false;
        void scrollToBottom({ animation: "instant" });
      },
    }),
    [state, scrollToBottom],
  );
  useLayoutEffect(() => {
    if (!pinRef) return;
    pinRef.current = pin;
    return () => {
      pinRef.current = null;
    };
  }, [pin, pinRef]);
  return (
    <ConversationPin.Provider value={pin}>
      {children}
    </ConversationPin.Provider>
  );
};

/* e2e/dev knob — `?stickDropMs=<ms>` keeps the library's post-resize
   scroll-event drop window (`state.resizeDifference`) forced open for <ms>
   after the port mounts: the exact condition under which an upward scroll's
   escape is swallowed and the bottom lock re-pins over the reader (#626).
   Read once at module load, like `?findUnstubNudge=`. */
const STICK_DROP_MS = (() => {
  if (typeof window === "undefined") return 0;
  const v = Number(
    new URLSearchParams(window.location.search).get("stickDropMs"),
  );
  return Number.isFinite(v) && v > 0 ? v : 0;
})();

const StickDropWindow = (): null => {
  const { state } = useStickToBottomContext();
  useEffect(() => {
    const until = Date.now() + STICK_DROP_MS;
    const id = setInterval(() => {
      /* A foreign value never equals a real resize's difference, so the
         library's own reset can't clear it early. */
      state.resizeDifference =
        Date.now() > until ? 0 : Number.MAX_SAFE_INTEGER;
      if (Date.now() > until) clearInterval(id);
    }, 5);
    return () => {
      state.resizeDifference = 0;
      clearInterval(id);
    };
  }, [state]);
  return null;
};

/* e2e/dev knob — `?pinDebug=1` exposes the live pin state on the scroll
   port (`port.__pin = { state }`) so a driving script can sample
   isAtBottom/escapedFromLock/animation per frame. Read once at module
   load, like `?stickDropMs=`. */
const PIN_DEBUG = (() => {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("pinDebug");
})();

/* Keys that scroll a focused scrollport — reader intent, not layout. */
const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

/* How long after the last held→real commit the hydration wave still
   counts as in flight — knob-delayed un-holds space commits ~60–100 ms
   apart, so 300 ms bridges the gaps without lingering once it ends. */
const HYDRATION_QUIET_MS = 300;

/* #626: the library's upward-scroll escape rides a setTimeout(1) that a
   post-resize `resizeDifference` window can swallow — then `isAtBottom`
   stays stale-true and the still-running bottom-lock spring physically
   re-pins the port over the reader's position (the ac-535 Focus flake:
   the port snapped back to the bottom, so the ↓ never mounted). A wheel
   gesture escapes synchronously, but a drag/keyboard/programmatic scroll
   has only the droppable event path.
   #570 flips the same race inside out: a born-held stub hydrating
   shorter than its estimate CLAMPS scrollTop — an un-attributed
   up-scroll event whose deferred escape can land past the reset on a
   slow box and kill the pin mid-open; and a coalesced event can even
   read a taller scrollHeight than the clamp saw, landing the port
   mid-document where "on the bottom edge" can't excuse it.
   So this guard owns escape intent outright: the READER is wheel-up,
   touch, a nav key, or a decreasing JS scrollTop write — everything
   else during the hydration window is layout noise and the bounded
   frame chain re-pins to the measured bottom until it drains. Outside
   the window an off-edge up-scroll still escapes synchronously (#626's
   drop-window fix stands). */
const ConversationEscapeGuard = (): null => {
  const pin = useContext(ConversationPin);
  const { scrollRef, contentRef, state, stopScroll } =
    useStickToBottomContext();
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc || !pin) return;
    /* `?pinDebug=1` — the repro samples the live pin on the port. */
    if (PIN_DEBUG) (sc as unknown as { __pin: unknown }).__pin = pin;
    let last = sc.scrollTop;
    let cancelled = false;
    let rearmRaf = 0;
    let rearmFrames = 0;
    const escaped = pin.escaped;
    const hydrating = () =>
      performance.now() - pin.hydratedAt.v < HYDRATION_QUIET_MS;
    const atEdge = () =>
      sc.scrollHeight - sc.scrollTop - sc.clientHeight <= 1.5;
    /* A browser clamp always lands scrollTop on a layout max
       (scrollHeight − clientHeight). Every height change passes a
       React commit (LazyShell bumps noteMax) or the content observer
       below, so every max that ever existed is in {prevMax, staleMaxes} —
       and every clamp landing is fingerprinted. An event coalesced past
       later growth reads a STALE max: the exact CI strand shape. A
       scrollbar drag or wheel lands anywhere else — not a clamp. */
    let prevMax = sc.scrollHeight - sc.clientHeight;
    const staleMaxes = new Set<number>();
    const noteMax = () => {
      const max = sc.scrollHeight - sc.clientHeight;
      if (max === prevMax) return;
      staleMaxes.add(prevMax);
      if (staleMaxes.size > 24)
        staleMaxes.delete(staleMaxes.values().next().value as number);
      prevMax = max;
    };
    const isClampTop = () =>
      atEdge() ||
      /* 0 is the reader's top edge (an `initial={false}` jump-pending
         mount), never a clamp worth reviving. */
      (sc.scrollTop !== 0 &&
        (sc.scrollTop === prevMax || staleMaxes.has(sc.scrollTop)));
    pin.noteMax = noteMax;
    pin.isClampTop = isClampTop;
    const escape = () => {
      escaped.v = true;
      stopScroll();
    };

    /* #570: while the pin is engaged the port must not let the browser's
       scroll anchor correct for height deltas above the view — a held
       stub hydrating taller/shorter than its estimate makes the engine
       write scrollTop to keep the view still, and that up-scroll event
       is indistinguishable from a reader escape (#626); on a slow box
       it lands outside the library's post-resize drop window and kills
       the pin mid-open. The find window owns the flag while it runs
       (#537): its top-edge hold needs anchoring off too. Reconciled on
       every scroll/resize signal — the pin's truth is the mutable
       state, React copies lag the anchor's raw writes. */
    const reconcileAnchor = () => {
      const want =
        (state.isAtBottom && !state.escapedFromLock) || findAnchorActive(state)
          ? "none"
          : "";
      if (sc.style.overflowAnchor !== want) sc.style.overflowAnchor = want;
    };

    /* A dead pin sitting on a clamp landing (the current edge or a
       recorded max) was killed by layout, not the reader — re-pin it.
       Its library escape rides a deferred timeout that can land on
       either side of any single frame check, so the reinstate runs a
       short frame chain: each new suspicious event or hydration commit
       refreshes the budget, so the wave is covered end to end. A real
       reader escape sets escaped and stops the chain on the next
       frame; a find window's top-edge hold owns the port for its whole
       swap wave, so the re-pin stands down while it holds. */
    const reinstateStep = () => {
      rearmRaf = 0;
      if (cancelled || escaped.v) return;
      if (!state.isAtBottom && !findAnchorActive(state) && isClampTop())
        pin.repin();
      if (--rearmFrames > 0) rearmRaf = requestAnimationFrame(reinstateStep);
    };
    const armReinstate = () => {
      rearmFrames = 8;
      if (!rearmRaf) rearmRaf = requestAnimationFrame(reinstateStep);
    };
    pin.armReinstate = armReinstate;

    const guard = () => {
      const top = sc.scrollTop;
      const up = top < last;
      last = top;
      /* The clamp fingerprint must see the max from BEFORE this event
         — capture it, then record. */
      const maxBefore = prevMax;
      noteMax();
      reconcileAnchor();
      /* state.isNearBottom reads live scroll geometry — never the
         droppable flags. */
      if (state.isNearBottom) escaped.v = false;
      if (!up) return;
      /* An up-scroll landing on a layout max — the current edge, the
         previous one (the event can beat the resize observer), or one a
         few commits back (the event coalesced past growth: the CI
         strand) — is a browser clamp, not the reader. During the
         hydration wave ANY un-attributed up-scroll is quarantined the
         same way: the reader's wheel/key/write was already caught
         synchronously by the input paths. Quiet-window off-fingerprint
         up-scrolls still kill the spring synchronously (#626) — but
         through the LIBRARY flags only: `escaped` is input-proven
         intent, so a misread noise escape can't strand the pin — the
         next clamp-landing commit revives it through the chain. */
      if (
        atEdge() ||
        (top !== 0 && (top === maxBefore || staleMaxes.has(top))) ||
        hydrating()
      ) {
        armReinstate();
        return;
      }
      stopScroll();
    };
    const denyRepin = () => {
      if (escaped.v && state.isAtBottom && !state.escapedFromLock)
        stopScroll();
    };
    const onScroll = () => {
      guard();
      denyRepin();
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    /* Flag-only re-pins fire no scroll event — catch them on the same
       content resize that triggered them (the library's observer runs
       first, so its re-pin is already visible here). */
    const content = contentRef.current;
    const ro = new ResizeObserver(onScroll);
    if (content) ro.observe(content);

    /* Reader intent arrives as INPUT, not scroll deltas: wheel-up and
       touch drags on the port, nav keys while it's focused, a press in
       the scrollbar gutter. Escape synchronously — before the in-flight
       spring's next frame can overwrite the reader's landing. */
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) escape();
    };
    const onTouchMove = () => escape();
    const onKeyDown = (e: KeyboardEvent) => {
      /* Keys aimed at a control belong to it — Space on a focused button
         clicks, arrows in an editor move the caret — neither scrolls the
         port, so neither is reader intent. */
      if (
        e.target instanceof Element &&
        e.target.closest(
          'input,textarea,select,button,[contenteditable]:not([contenteditable="false"])',
        )
      )
        return;
      if (SCROLL_KEYS.has(e.key)) escape();
    };
    const onPointerDown = (e: PointerEvent) => {
      /* offsetX/Y are relative to the event's TARGET, not the port —
         only a press targeting the port itself can land in the
         scrollbar gutter; a bubbled press inside a row taller than the
         port would otherwise misread as a gutter grab. */
      if (
        e.target === sc &&
        (e.offsetX > sc.clientWidth || e.offsetY > sc.clientHeight)
      )
        escape();
    };
    sc.addEventListener("wheel", onWheel, { passive: true });
    sc.addEventListener("touchmove", onTouchMove, { passive: true });
    sc.addEventListener("keydown", onKeyDown);
    sc.addEventListener("pointerdown", onPointerDown);

    /* #570: a programmatic scrollTop write (a spec's `port.scrollTop =
       0`, the find nudge knob) can be overwritten by the in-flight
       bottom spring before its scroll event even dispatches — the
       coalesced event reads the spring's value, the escape never lands,
       and the port is dragged back to the bottom. A JS write that
       LOWERS scrollTop and lands off the bottom edge is the reader
       jumping: escape synchronously, before the spring's next frame.
       The library's own decreasing writes land ON the bottom edge (its
       ResizeObserver overscroll clamp), so they pass; native scrolls —
       wheel, drag, scrollIntoView — never touch this setter. */
    let proto: object | null = sc;
    let desc: PropertyDescriptor | undefined;
    while (
      proto &&
      !(desc = Object.getOwnPropertyDescriptor(proto, "scrollTop"))
    )
      proto = Object.getPrototypeOf(proto);
    let patched = false;
    if (desc?.get && desc.set) {
      patched = true;
      const get = desc.get as (this: Element) => number;
      const set = desc.set as (this: Element, v: number) => void;
      Object.defineProperty(sc, "scrollTop", {
        configurable: true,
        enumerable: desc.enumerable,
        get() {
          return get.call(this);
        },
        set(v: number) {
          const before = get.call(sc);
          set.call(sc, v);
          const after = get.call(sc);
          if (
            after < before &&
            state.isAtBottom &&
            sc.scrollHeight - after - sc.clientHeight > 1.5
          )
            escape();
        },
      });
    }
    reconcileAnchor();
    return () => {
      cancelled = true;
      cancelAnimationFrame(rearmRaf);
      pin.armReinstate = undefined;
      pin.isClampTop = undefined;
      pin.noteMax = undefined;
      sc.removeEventListener("scroll", onScroll);
      sc.removeEventListener("wheel", onWheel);
      sc.removeEventListener("touchmove", onTouchMove);
      sc.removeEventListener("keydown", onKeyDown);
      sc.removeEventListener("pointerdown", onPointerDown);
      ro.disconnect();
      if (patched) Reflect.deleteProperty(sc, "scrollTop");
      if (!findAnchorActive(state)) sc.style.overflowAnchor = "";
    };
  }, [pin, scrollRef, contentRef, state, stopScroll]);
  return null;
};

/* The ↓ button floats in a 56px gutter below the scroller — padding on the
   port shrinks its content box, and the scroller's height:100% resolves
   against that, so rows can never reach the strip the button sits in at any
   scroll offset (issue #535). The gutter exists only while the button is
   mounted (`has-[.lilos-scroll-btn]`): the ↓ unmounts at the bottom, so a
   permanent strip left a dead band between the last row and the composer
   (issue #602). */
export const Conversation = ({
  className,
  children,
  pinRef,
  ...props
}: ConversationProps) => (
  <StickToBottom
    className={cn(
      "relative flex-1 overflow-y-hidden has-[.lilos-scroll-btn]:pb-14",
      className,
    )}
    initial="smooth"
    resize="smooth"
    role="log"
    {...props}
  >
    {/* StickToBottom also accepts a function child; every Conversation
        caller passes nodes, so the union is narrowed for JSX. */}
    <ConversationPinBridge pinRef={pinRef}>
      <ConversationEscapeGuard />
      {STICK_DROP_MS > 0 && <StickDropWindow />}
      {children as ReactNode}
    </ConversationPinBridge>
  </StickToBottom>
);

export type ConversationContentProps = ComponentProps<
  typeof StickToBottom.Content
>;

export const ConversationContent = ({
  className,
  ...props
}: ConversationContentProps) => (
  <StickToBottom.Content
    className={cn("flex flex-col gap-8 p-4", className)}
    {...props}
  />
);

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    !isAtBottom && (
      <Button
        className={cn(
          "lilos-scroll-btn absolute bottom-3 left-[50%] translate-x-[-50%] rounded-full",
          className
        )}
        onClick={handleScrollToBottom}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  );
};
