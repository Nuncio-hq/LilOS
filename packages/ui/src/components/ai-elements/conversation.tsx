"use client";

import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useCallback, useEffect } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

/* TEMP #626 debug knob — `?stickProbe` records a ring-buffer timeline on
   window.__stick: stick-to-bottom state, every script scrollTop write with a
   stack, scroll events and content resizes. Removed before READY. */
const STICK_PROBE =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("stickProbe");

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
  const { scrollRef, contentRef, state, stopScroll } =
    useStickToBottomContext();
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    let last = sc.scrollTop;
    /* The reader's escape stands while they hold a position outside the
       near-bottom band; being inside the band (their own scroll, a
       shrink, a settle) re-arms the lock normally. */
    let readerEscape = false;
    const guard = () => {
      const top = sc.scrollTop;
      const up = top < last;
      last = top;
      /* state.isNearBottom reads live scroll geometry — never the
         droppable flags. */
      if (state.isNearBottom) {
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
    /* Flag-only re-pins fire no scroll event — catch them on the same
       content resize that triggered them (the library's observer runs
       first, so its re-pin is already visible here). */
    const content = contentRef.current;
    const ro = new ResizeObserver(guard);
    if (content) ro.observe(content);
    return () => {
      sc.removeEventListener("scroll", guard);
      ro.disconnect();
    };
  }, [scrollRef, contentRef, state, stopScroll]);
  return null;
};

const StickProbe = (): null => {
  const { scrollRef, contentRef, state } = useStickToBottomContext();
  useEffect(() => {
    const w = window as unknown as {
      __stick?: Array<Record<string, unknown>>;
      __stickN?: number;
    };
    const log = (w.__stick = w.__stick ?? []);
    const pid = (w.__stickN = (w.__stickN ?? 0) + 1);
    const sc = scrollRef.current as HTMLElement | null;
    const content = contentRef.current as HTMLElement | null;
    const snap = (kind: string, extra?: Record<string, unknown>) => {
      log.push({
        t: Math.round(performance.now()),
        pid,
        kind,
        top: sc?.scrollTop,
        h: sc?.scrollHeight,
        ch: sc?.clientHeight,
        atB: state.isAtBottom,
        near: state.isNearBottom,
        esc: state.escapedFromLock,
        rd: state.resizeDifference,
        anim: state.animation ? "y" : undefined,
        ...extra,
      });
      if (log.length > 3000) log.splice(0, 1500);
    };
    snap("mount");
    const proto = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollTop",
    );
    if (sc && proto?.get && proto.set) {
      Object.defineProperty(sc, "scrollTop", {
        configurable: true,
        get() {
          return proto.get!.call(this);
        },
        set(v: number) {
          snap("setTop", {
            v,
            stack: (new Error().stack ?? "")
              .split("\n")
              .slice(2, 7)
              .join("<"),
          });
          proto.set!.call(this, v);
        },
      });
    }
    const onScroll = () => snap("scroll");
    sc?.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => snap("ro"));
    if (content) ro.observe(content);
    return () => {
      sc?.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (sc && proto) delete (sc as unknown as Record<string, unknown>).scrollTop;
    };
  }, [scrollRef, contentRef, state]);
  return null;
};

/* pb-14 reserves the ↓ button's height as a real gutter below the scroller:
   bottom padding on the port shrinks its content box, and the scroller's
   height:100% resolves against that — so message rows can never reach the
   strip the button floats in, at any scroll offset (issue #535). */
export const Conversation = ({
  className,
  children,
  ...props
}: ConversationProps) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden pb-14", className)}
    initial="smooth"
    resize="smooth"
    role="log"
    {...props}
  >
    <ConversationEscapeGuard />
    {STICK_PROBE && <StickProbe />}
    {STICK_DROP_MS > 0 && <StickDropWindow />}
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
          "absolute bottom-3 left-[50%] translate-x-[-50%] rounded-full",
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
