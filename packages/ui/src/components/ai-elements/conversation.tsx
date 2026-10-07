"use client";

import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useCallback, useEffect } from "react";
import {
  type StickToBottomState,
  StickToBottom,
  useStickToBottomContext,
} from "use-stick-to-bottom";
import { findAnchorActive } from "../../conversation/find-unstub";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

/* The pin's live `state` for rows that re-pin on hydrate (#570's
   LazyShell). The object is stable for the StickToBottom instance, so
   this context's value never changes and consumers never re-render on
   pin flag flips. */
export const ConversationPin = createContext<StickToBottomState | null>(null);

const ConversationPinBridge = ({
  children,
}: {
  children: ReactNode;
}) => {
  const { state } = useStickToBottomContext();
  return (
    <ConversationPin.Provider value={state}>
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

/* #626: the library's upward-scroll escape rides a setTimeout(1) that a
   post-resize `resizeDifference` window can swallow — then `isAtBottom`
   stays stale-true and the still-running bottom-lock spring physically
   re-pins the port over the reader's position (the ac-535 Focus flake:
   the port snapped back to the bottom, so the ↓ never mounted). A wheel
   gesture escapes synchronously, but a drag/keyboard/programmatic scroll
   has only the droppable event path.
   This guard owns the escape itself: any upward scroll leaving the
   near-bottom band calls stopScroll — synchronous, no drop window — and
   while the reader stays escaped it denies flag-only re-pins (a shrink
   re-engaging the lock, a dropped near-flag refresh). scrollToBottom
   callers keep escapedFromLock set, so intended pins aren't caught. */
const ConversationEscapeGuard = (): null => {
  const { scrollRef, contentRef, state, stopScroll, scrollToBottom } =
    useStickToBottomContext();
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    let last = sc.scrollTop;
    /* The reader's escape stands while they hold a position outside the
       near-bottom band; being inside the band (their own scroll, a
       shrink, a settle) re-arms the lock normally. */
    let readerEscape = false;
    let cancelled = false;
    let rearmRaf = 0;

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

    /* A scroll event that moved UP but left the port on the bottom edge
       is a layout clamp — content shrank under the pin — not a reader
       scroll. Its escape rides the library's deferred 1 ms timeout, which
       can land on either side of any single frame check, so the reinstate
       runs a short frame chain instead of one shot: every frame the pin
       is dead while the port still sits on the bottom edge, re-pin to the
       measured bottom (the write carries ignoreScrollToTop, so the stale
       event can't re-escape it). A real reader escape leaves the edge —
       or sets readerEscape — and stops the chain. Each new clamp event
       refreshes the budget, so a hydration wave is covered end to end. */
    let rearmFrames = 0;
    const reinstateStep = () => {
      rearmRaf = 0;
      if (cancelled || readerEscape) return;
      if (!state.isAtBottom) {
        if (sc.scrollHeight - sc.scrollTop - sc.clientHeight > 1.5) return;
        state.escapedFromLock = false;
        void scrollToBottom({ animation: "instant" });
      }
      if (--rearmFrames > 0) rearmRaf = requestAnimationFrame(reinstateStep);
    };
    const armReinstate = () => {
      rearmFrames = 8;
      if (!rearmRaf) rearmRaf = requestAnimationFrame(reinstateStep);
    };

    const guard = () => {
      const top = sc.scrollTop;
      const up = top < last;
      last = top;
      reconcileAnchor();
      /* state.isNearBottom reads live scroll geometry — never the
         droppable flags. */
      if (state.isNearBottom) {
        readerEscape = false;
        /* The pin's target is scrollHeight − 1 − clientHeight; a
           browser clamp lands at scrollHeight − clientHeight. Anything
           within that ~1.5 px band moving up is layout, not a reader. */
        if (
          up &&
          state.isAtBottom &&
          sc.scrollHeight - top - sc.clientHeight <= 1.5
        )
          armReinstate();
      } else if (up) {
        readerEscape = true;
        stopScroll();
      } else if (
        readerEscape &&
        state.isAtBottom &&
        !state.escapedFromLock
      ) {
        stopScroll();
      }
    };
    sc.addEventListener("scroll", guard, { passive: true });
    /* Flag-only re-pins fire no scroll event — catch them on the same
       content resize that triggered them (the library's observer runs
       first, so its re-pin is already visible here). */
    const content = contentRef.current;
    const ro = new ResizeObserver(guard);
    if (content) ro.observe(content);

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
          ) {
            readerEscape = true;
            stopScroll();
          }
        },
      });
    }
    reconcileAnchor();
    return () => {
      cancelled = true;
      cancelAnimationFrame(rearmRaf);
      sc.removeEventListener("scroll", guard);
      ro.disconnect();
      if (patched) Reflect.deleteProperty(sc, "scrollTop");
      if (!findAnchorActive(state)) sc.style.overflowAnchor = "";
    };
  }, [scrollRef, contentRef, state, stopScroll, scrollToBottom]);
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
    <ConversationEscapeGuard />
    {STICK_DROP_MS > 0 && <StickDropWindow />}
    {/* StickToBottom also accepts a function child; every Conversation
        caller passes nodes, so the union is narrowed for JSX. */}
    <ConversationPinBridge>
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
