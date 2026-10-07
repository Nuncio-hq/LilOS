"use client";

import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useCallback, useEffect } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

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
    let lastHeight = sc.clientHeight;
    /* The reader's escape stands while they hold a position outside the
       near-bottom band; being inside the band (their own scroll, a
       shrink, a settle) re-arms the lock normally. */
    let readerEscape = false;
    let heal: ReturnType<typeof setTimeout> | undefined;
    /* The port position the heal was scheduled from — a real gesture
       that has already moved it must not be undone. */
    let healTop = 0;
    const cancelHeal = () => {
      if (heal !== undefined) {
        clearTimeout(heal);
        heal = undefined;
      }
    };
    /* Put the bottom lock back after a layout nudge: the flags were
       cleared by the library's own 1ms scroll path, so this must run
       after it — the 2ms timer beats it on the same task queue. The
       write+scrollToBottom pair is the same one ConversationKeepBottom
       uses. The wheel escape sets those flags synchronously — before
       its scroll event exists — so the drift check and the gesture
       cancels below keep a real scroll-up inside the window from being
       eaten. */
    const repin = () => {
      heal = undefined;
      if (readerEscape || sc.scrollTop < healTop - 1) return;
      state.escapedFromLock = false;
      state.isAtBottom = true;
      scrollToBottom({ animation: "instant" });
      sc.scrollTop = sc.scrollHeight;
    };
    const wheel = (e: WheelEvent) => {
      if (e.deltaY < 0) cancelHeal();
    };
    const guard = () => {
      const top = sc.scrollTop;
      const up = top < last;
      /* A change in the port's own height (composer/tray growth, the ↓
         gutter toggling, window resize) moves scrollTop via the
         browser's scroll anchoring, and a content shrink clamps scrollTop
         down to the new maximum — an up-scroll that arrives WITH a height
         change, or lands AT the maximum, is layout, not the reader (the
         reader cannot scroll up into the maximum; only a clamp lands
         there). The library escapes on any up-scroll regardless, so
         without the heal the bottom lock dies mid-stream and the last
         card parks under the composer (#649). */
      const clamped = top >= sc.scrollHeight - sc.clientHeight - 2;
      const shifted = sc.clientHeight !== lastHeight;
      last = top;
      lastHeight = sc.clientHeight;
      if (up && (shifted || clamped) && !readerEscape) {
        cancelHeal();
        healTop = top;
        heal = setTimeout(repin, 2);
      } else if (state.isNearBottom) {
        readerEscape = false;
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
    sc.addEventListener("wheel", wheel, { passive: true });
    sc.addEventListener("touchstart", cancelHeal, { passive: true });
    /* Flag-only re-pins fire no scroll event — catch them on the same
       content resize that triggered them (the library's observer runs
       first, so its re-pin is already visible here). Observing the port
       too keeps lastHeight fresh on resizes that fire no scroll event. */
    const ro = new ResizeObserver(guard);
    if (contentRef.current) ro.observe(contentRef.current);
    ro.observe(sc);
    return () => {
      cancelHeal();
      sc.removeEventListener("scroll", guard);
      sc.removeEventListener("wheel", wheel);
      sc.removeEventListener("touchstart", cancelHeal);
      ro.disconnect();
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
    {children as ReactNode}
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
    className={cn(
      "flex flex-col gap-8 p-4",
      className,
    )}
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
