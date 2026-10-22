import { type ReactNode, type Ref, useEffect, useState } from "react";
import { cn } from "../lib/utils";
import type { V3StepKind } from "./v3-types";

/* Shared pieces for v3 pages: the page column and its title, buttons, tabs,
   property rows, steps and small time words. The marks (status, avatars) are
   in v3-marks, the open-record rows in v3-open-record. */

/** Thin progress line: goals, context, spend. */
export function Meter({
  value,
  className,
  tone = "ink",
}: {
  value: number;
  className?: string;
  tone?: "ink" | "soft";
}) {
  return (
    <span
      className={cn(
        "block h-1 overflow-hidden rounded-full bg-[var(--v3-line)]",
        className,
      )}
    >
      <span
        className={cn(
          "block h-full rounded-full transition-[width] duration-500",
          tone === "ink" ? "bg-foreground/85" : "bg-muted-foreground/60",
        )}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </span>
  );
}

export function Kbd({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        "rounded border border-[var(--v3-line)] bg-background px-1.5 font-sans text-[11px] text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Btn({
  children,
  onClick,
  primary,
  small,
  className,
  title,
  disabled,
  pressed,
  ref,
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  small?: boolean;
  className?: string;
  title?: string;
  disabled?: boolean;
  /** Stays in its pressed look while a form it opened is on screen. */
  pressed?: boolean;
  /** For a caller that moves the keyboard here (a confirm's safe answer). */
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      title={title}
      disabled={disabled}
      aria-pressed={pressed || undefined}
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border font-medium text-[13px] transition-[background,transform] active:scale-[0.97]",
        small ? "h-[26px] px-2.5" : "h-7 px-3",
        primary
          ? "border-foreground bg-foreground text-background hover:bg-foreground/85"
          : "border-foreground/15 bg-background text-foreground hover:bg-[var(--v3-hover)]",
        pressed && !primary && "bg-[var(--v3-hover)]",
        disabled && "pointer-events-none opacity-60",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** The page column: Notion's centred reading width. */
export function Page({
  children,
  wide,
  className,
}: {
  children: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-8 pt-10 pb-24",
        wide ? "max-w-[880px]" : "max-w-[740px]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Title({
  kicker,
  children,
  small,
}: {
  kicker?: ReactNode;
  children: ReactNode;
  small?: boolean;
}) {
  return (
    <>
      {kicker && (
        <div className="mb-2 text-[13.5px] text-muted-foreground">{kicker}</div>
      )}
      <h1
        className={cn(
          "lilos-v3-serif mb-3.5 font-bold leading-[1.15] text-foreground",
          small ? "text-[30px]" : "text-[38px]",
        )}
      >
        {children}
      </h1>
    </>
  );
}

/** Section header: title, a quiet count, an optional note, and an
    optional link on the right. A count of 0 is left out (D-#769): the
    empty line under the heading already says there is nothing, so
    "Needs you 0" above "Nothing needs you." would say it twice. A
    positive count stays. A count that is not a bare number ("2 more")
    stays. The note stays either way. */
export function Section({
  title,
  count,
  note,
  link,
  onLink,
  className,
}: {
  title: ReactNode;
  count?: ReactNode;
  /** Words after the count. Not a tally, so a zero count does not hide it. */
  note?: ReactNode;
  link?: string;
  onLink?: () => void;
  className?: string;
}) {
  const quiet = count === 0 || count === "0" ? undefined : count;
  return (
    <h3
      className={cn(
        "mt-10 mb-1.5 flex items-baseline gap-2 font-semibold text-[15px] text-foreground",
        className,
      )}
    >
      {title}
      {quiet !== undefined && (
        <small className="font-normal text-[13px] text-muted-foreground/70">
          {quiet}
        </small>
      )}
      {note != null && (
        <span className="font-normal text-[13px] text-muted-foreground">
          {note}
        </span>
      )}
      {link && (
        <button
          type="button"
          onClick={onLink}
          className="ml-auto font-normal text-[13px] text-muted-foreground hover:text-foreground"
        >
          {link}
        </button>
      )}
    </h3>
  );
}

/** Notion-style view tabs under a page title. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  right,
}: {
  tabs: { id: T; label: string; icon?: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  right?: ReactNode;
}) {
  return (
    // Tabs never wrap; a pane too narrow for them scrolls the row instead.
    <div className="no-scrollbar mt-6 flex items-center gap-0.5 overflow-x-auto border-[var(--v3-line)] border-b text-[14px] text-muted-foreground">
      {tabs.map((t) => (
        <button
          type="button"
          key={t.id}
          onClick={() => onChange(t.id)}
          title={t.label}
          className={cn(
            "relative flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 pt-1.5 pb-2.5 hover:text-foreground [&_svg]:size-4",
            value === t.id &&
              "font-medium text-foreground after:absolute after:right-2.5 after:-bottom-px after:left-2.5 after:h-0.5 after:rounded-full after:bg-foreground",
          )}
        >
          {t.icon}
          {/* Beside an open record the page narrows: tabs with an icon fold
              to it, except the open one, so none is cut off. */}
          <span
            className={cn(t.icon && value !== t.id && "@max-[560px]:sr-only")}
          >
            {t.label}
          </span>
        </button>
      ))}
      {right && (
        <div className="ml-auto flex shrink-0 items-center gap-4 whitespace-nowrap pb-1.5 pl-4 text-[13.5px] text-muted-foreground/70">
          {right}
        </div>
      )}
    </div>
  );
}

/** One property row on a page: icon + key on the left, value on the right. */
export function Prop({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-9 items-center text-[14px]">
      <span className="flex w-[150px] shrink-0 items-center gap-2 text-muted-foreground [&_svg]:size-4 [&_svg]:opacity-70">
        {icon}
        {label}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        {children}
      </span>
    </div>
  );
}

/** Ticket id in front of a title. */
export function TicketId({
  id,
  className,
}: {
  id: string;
  className?: string;
}) {
  return (
    <span
      className={cn("mr-2.5 text-[12.5px] text-muted-foreground/70", className)}
    >
      {id}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className={cn(
        "size-3.5 shrink-0 animate-spin text-sky-600 dark:text-sky-400",
        className,
      )}
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeOpacity=".2"
        strokeWidth="2"
      />
      <path
        d="M8 2a6 6 0 0 1 6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export const STEP_VERB: Record<V3StepKind, string> = {
  read: "Read",
  search: "Searched",
  edit: "Edited",
  run: "Ran",
  web: "Browsed",
  think: "Thought",
  delegate: "Delegated",
};

export function Diff({ add, del }: { add: number; del: number }) {
  return (
    <span className="whitespace-nowrap text-[12.5px]">
      <span className="text-emerald-700 dark:text-emerald-400">+{add}</span>{" "}
      <span className="text-red-600 dark:text-red-400">−{del}</span>
    </span>
  );
}

/** Minutes → "now" · "12m" · "2h" · "3d". A duration, not a phrase:
    callers that want "5m ago" use `relativeTime`. */
export const ago = (m: number) =>
  m < 1
    ? "now"
    : m < 60
      ? `${m}m`
      : m < 1440
        ? `${Math.round(m / 60)}h`
        : `${Math.round(m / 1440)}d`;

/** Minutes as a phrase: "just now", "5m ago", "2h ago", "3d ago".
    The words include "ago". Writing `${ago(m)} ago` made "now ago"
    wherever a clock was under a minute (#800, ticket updates). */
export const relativeTime = (m: number) =>
  m < 1 ? "just now" : `${ago(m)} ago`;

/** Minutes → "1h 50m". */
export const span = (m: number) =>
  m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;

/** A counter that ticks every `ms`, so live surfaces move in the prototype. */
export function useTick(ms = 1500) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setN((x) => x + 1), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return n;
}
