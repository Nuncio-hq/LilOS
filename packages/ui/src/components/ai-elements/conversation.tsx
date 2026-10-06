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
    {STICK_PROBE && <StickProbe />}
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
