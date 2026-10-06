"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { useTurnBlockState } from "../../lib/block-state";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible";
import { cn } from "../../lib/utils";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, memo, useCallback, useContext, useEffect, useState } from "react";
import { Streamdown } from "streamdown";
import {
  safeMessageComponents,
  safeMessageRehypePlugins,
} from "./message-safety";
import { Shimmer } from "./shimmer";

type ReasoningContextValue = {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
};

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
  /* Conv-scoped persist key — survives card remounts (#320). */
  openKey?: string;
};

const AUTO_CLOSE_DELAY = 1000;
const MS_IN_S = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen = true,
    onOpenChange,
    duration: durationProp,
    children,
    openKey,
    ...props
  }: ReasoningProps) => {
    /* #320: {open, touched} outlives remounts when openKey is set — a
       user-collapsed (or re-opened) block keeps its state. */
    const [persist, setPersist] = useTurnBlockState<{
      open?: boolean;
      touched?: boolean;
    }>(openKey, {});
    const [isOpen, setIsOpenRaw] = useControllableState({
      prop: open,
      defaultProp: persist.open ?? defaultOpen,
      onChange: onOpenChange,
    });
    /* Stable across renders: the auto-close effect lists this as a dep, and
       an unstable setter would re-arm its 1s timer on every streamed update. */
    const setIsOpen = useCallback(
      (v: boolean) => {
        setPersist((p) => ({ ...p, open: v }));
        setIsOpenRaw(v);
      },
      [setPersist, setIsOpenRaw],
    );
    const [duration, setDuration] = useControllableState({
      prop: durationProp,
      defaultProp: undefined,
    });

    const [hasAutoClosed, setHasAutoClosed] = useState(false);
    const [startTime, setStartTime] = useState<number | null>(null);
    /* #320: the first user toggle wins for the rest of the stream — a
       user-opened reasoning block must not fold back when streaming ends. */
    const userTouched = persist.touched ?? false;

    // Track duration when streaming starts and ends
    useEffect(() => {
      if (isStreaming) {
        if (startTime === null) {
          setStartTime(Date.now());
        }
      } else if (startTime !== null) {
        setDuration(Math.ceil((Date.now() - startTime) / MS_IN_S));
        setStartTime(null);
      }
    }, [isStreaming, startTime, setDuration]);

    // Auto-open when streaming starts, auto-close when streaming ends (once only)
    useEffect(() => {
      if (defaultOpen && !isStreaming && isOpen && !hasAutoClosed && !userTouched) {
        // Add a small delay before closing to allow user to see the content
        const timer = setTimeout(() => {
          setIsOpen(false);
          setHasAutoClosed(true);
        }, AUTO_CLOSE_DELAY);

        return () => clearTimeout(timer);
      }
    }, [
      isStreaming,
      isOpen,
      defaultOpen,
      setIsOpen,
      hasAutoClosed,
      userTouched,
    ]);

    const handleOpenChange = (newOpen: boolean) => {
      setPersist({ open: newOpen, touched: true });
      setIsOpenRaw(newOpen);
    };

    /* Settle folds the block unless the user touched it. The conv-keyed row
       survives live→settled without a remount, so the fold can't lean on a
       remount's `defaultOpen=false` initial state — `defaultOpen` tracks
       r.live here, and once it drops only a user choice keeps the block open. */
    const shown = isOpen && (isStreaming || defaultOpen || userTouched);

    return (
      <ReasoningContext.Provider
        value={{ isStreaming, isOpen: shown, setIsOpen, duration }}
      >
        <Collapsible
          className={cn("not-prose mb-4", className)}
          onOpenChange={handleOpenChange}
          open={shown}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  }
);

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
};

const defaultGetThinkingMessage = (isStreaming: boolean, duration?: number) => {
  if (isStreaming || duration === 0) {
    return <Shimmer duration={1}>Thinking...</Shimmer>;
  }
  if (duration === undefined) {
    return <p>Thought for a few seconds</p>;
  }
  return <p>Thought for {duration} seconds</p>;
};

export const ReasoningTrigger = memo(
  ({ className, children, getThinkingMessage = defaultGetThinkingMessage, ...props }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen, duration } = useReasoning();

    return (
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground",
          className
        )}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="size-4" />
            {getThinkingMessage(isStreaming, duration)}
            <ChevronDownIcon
              className={cn(
                "size-4 transition-transform",
                isOpen ? "rotate-180" : "rotate-0"
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  }
);

export type ReasoningContentProps = ComponentProps<
  typeof CollapsibleContent
> & {
  children: string;
};

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => (
    <CollapsibleContent
      /* #400: keep the folded reasoning in the DOM when closed —
         unmounting at the settle animation's whim means the turn's text
         silently leaves the page while its model still has it (the ac-27
         AC-5b flake). `until-found` also lets in-page search expand the
         block. It stays hidden — nothing renders or lays out differently. */
      hiddenUntilFound
      className={cn(
        "mt-4 text-sm",
        "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
        className
      )}
      {...props}
    >
      {/* props belong to CollapsibleContent; Streamdown's `dir` type is narrower.
          Reasoning is agent-written markdown too — same reply safety (#566). */}
      <Streamdown
        components={safeMessageComponents}
        rehypePlugins={safeMessageRehypePlugins}
      >
        {children}
      </Streamdown>
    </CollapsibleContent>
  )
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
