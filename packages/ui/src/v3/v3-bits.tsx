import {
  BotIcon,
  BrainIcon,
  FileTextIcon,
  GlobeIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
} from "lucide-react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { cn } from "../lib/utils";
import type {
  V3Agent,
  V3Data,
  V3RecordRoute,
  V3Status,
  V3StepKind,
  V3Tone,
} from "./v3-types";

/* Shared marks for v3. One rule: colour belongs to status; avatars and
   project marks are soft pastels, everything else is ink on paper. */

export const STATUS_WORD: Record<V3Status, string> = {
  working: "Working",
  waiting: "Waiting",
  needs: "Needs you",
  stuck: "Stuck",
  idle: "Idle",
  done: "Done",
  planned: "Planned",
  failed: "Failed",
};

const PILL: Record<V3Status, string> = {
  working: "bg-sky-50 text-sky-700 dark:bg-sky-400/12 dark:text-sky-300",
  waiting:
    "bg-yellow-50 text-yellow-700 dark:bg-yellow-400/12 dark:text-yellow-300",
  needs:
    "bg-orange-50 text-orange-700 dark:bg-orange-400/14 dark:text-orange-300",
  stuck: "bg-red-50 text-red-700 dark:bg-red-400/14 dark:text-red-300",
  idle: "bg-stone-100 text-stone-500 dark:bg-stone-400/12 dark:text-stone-400",
  done: "bg-emerald-50 text-emerald-700 dark:bg-emerald-400/12 dark:text-emerald-300",
  planned:
    "bg-stone-100 text-stone-500 dark:bg-stone-400/12 dark:text-stone-400",
  failed: "bg-red-50 text-red-700 dark:bg-red-400/14 dark:text-red-300",
};

export const DOT: Record<V3Status, string> = {
  working: "bg-sky-600 dark:bg-sky-400",
  waiting: "bg-yellow-500",
  needs: "bg-orange-500",
  stuck: "bg-red-500",
  idle: "bg-stone-400",
  done: "bg-emerald-600 dark:bg-emerald-400",
  planned: "border border-stone-400 bg-transparent",
  failed: "bg-red-500",
};

/** Status text colour, for numbers and inline words that carry a state. */
export const INK: Record<V3Status, string> = {
  working: "text-sky-700 dark:text-sky-300",
  waiting: "text-yellow-700 dark:text-yellow-300",
  needs: "text-orange-700 dark:text-orange-300",
  stuck: "text-red-600 dark:text-red-300",
  idle: "text-stone-500",
  done: "text-emerald-700 dark:text-emerald-300",
  planned: "text-stone-500",
  failed: "text-red-600 dark:text-red-300",
};

export function StatusPill({
  status,
  label,
  className,
}: {
  status: V3Status;
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full pr-2.5 pl-2 font-medium text-[12.5px]",
        PILL[status],
        className,
      )}
    >
      <StatusDot status={status} />
      {label ?? STATUS_WORD[status]}
    </span>
  );
}

export function StatusDot({
  status,
  className,
}: {
  status: V3Status;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        DOT[status],
        status === "working" && "lilos-v2-breathe",
        className,
      )}
    />
  );
}

const TONE: Record<V3Tone, string> = {
  c: "bg-[#f2ebe1] text-[#8a6a3e] dark:bg-[#8a6a3e]/30 dark:text-[#e6cba4]",
  b: "bg-[#e5eef5] text-[#3d6a8c] dark:bg-[#3d6a8c]/35 dark:text-[#a9cbe6]",
  r: "bg-[#eee8f4] text-[#74569a] dark:bg-[#74569a]/35 dark:text-[#cdb8ea]",
  m: "bg-[#f6e9e1] text-[#a2603a] dark:bg-[#a2603a]/35 dark:text-[#ecc0a4]",
  s: "bg-[#e6f0ea] text-[#4a7a5d] dark:bg-[#4a7a5d]/35 dark:text-[#b2d8c0]",
  d: "bg-[#f4e8ee] text-[#9a4f73] dark:bg-[#9a4f73]/35 dark:text-[#e8b6cf]",
  n: "bg-foreground text-background",
};

export function Avatar({
  name,
  tone,
  size = 20,
  className,
  look,
}: {
  name: string;
  tone: V3Tone;
  size?: number;
  className?: string;
  /** An outside worker: its connector's mark on the connector's colour, in
     a rounded square, so a bot never looks like a LilOS agent. */
  look?: { mark: string; color: string };
}) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * (look && look.mark.length > 1 ? 0.4 : 0.5)),
        ...(look ? { background: look.color, color: "#fff" } : {}),
      }}
      className={cn(
        "inline-grid shrink-0 place-items-center font-semibold leading-none",
        look ? "rounded-[28%]" : ["rounded-full", TONE[tone]],
        className,
      )}
    >
      {look ? look.mark : name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** An agent's face wherever it appears: a LilOS agent's letter on its tone,
   or an outside worker's connector mark. An agent that is gone (its id
   outlived it) shows a neutral "?" instead of another agent's face. */
export function AgentAvatar({
  data,
  agent,
  size,
  className,
}: {
  data: V3Data;
  agent: V3Agent | undefined;
  size?: number;
  className?: string;
}) {
  if (!agent)
    return <Avatar name="?" tone="n" size={size} className={className} />;
  const via =
    agent.kind === "outside"
      ? data.connectors.find((c) => c.id === agent.via)
      : undefined;
  return (
    <Avatar
      name={agent.name}
      tone={agent.tone}
      size={size}
      className={className}
      look={via?.look}
    />
  );
}

/** The crown beside whoever holds the CEO position. */
export function CeoMark({ className }: { className?: string }) {
  return (
    <span
      title="Holds the CEO position"
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center rounded-full bg-amber-100 px-1.5 font-semibold text-[10.5px] text-amber-800 tracking-wide dark:bg-amber-400/15 dark:text-amber-300",
        className,
      )}
    >
      CEO
    </span>
  );
}

/** A small square letter mark for a project. */
export function ProjectMark({
  name,
  tone,
  className,
}: {
  name: string;
  tone: V3Tone;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-grid size-[18px] shrink-0 place-items-center rounded-[5px] font-bold text-[10px]",
        TONE[tone],
        className,
      )}
    >
      {name.slice(0, 1)}
    </span>
  );
}

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
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  small?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border font-medium text-[13px] transition-[background,transform] active:scale-[0.97]",
        small ? "h-[26px] px-2.5" : "h-7 px-3",
        primary
          ? "border-foreground bg-foreground text-background hover:bg-foreground/85"
          : "border-foreground/15 bg-background text-foreground hover:bg-[var(--v3-hover)]",
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

/** Section header: title, a quiet count, and an optional link on the right. */
export function Section({
  title,
  count,
  link,
  onLink,
  className,
}: {
  title: ReactNode;
  count?: ReactNode;
  link?: string;
  onLink?: () => void;
  className?: string;
}) {
  return (
    <h3
      className={cn(
        "mt-10 mb-1.5 flex items-baseline gap-2 font-semibold text-[15px] text-foreground",
        className,
      )}
    >
      {title}
      {count !== undefined && (
        <small className="font-normal text-[13px] text-muted-foreground/70">
          {count}
        </small>
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

const STEP_ICON: Record<V3StepKind, typeof FileTextIcon> = {
  read: FileTextIcon,
  search: SearchIcon,
  edit: PencilIcon,
  run: TerminalIcon,
  web: GlobeIcon,
  think: BrainIcon,
  delegate: BotIcon,
};

export const STEP_VERB: Record<V3StepKind, string> = {
  read: "Read",
  search: "Searched",
  edit: "Edited",
  run: "Ran",
  web: "Browsed",
  think: "Thought",
  delegate: "Delegated",
};

export function StepIcon({
  kind,
  className,
}: {
  kind: V3StepKind;
  className?: string;
}) {
  const Icon = STEP_ICON[kind];
  return (
    <Icon
      aria-hidden
      className={cn("size-[15px] shrink-0 text-muted-foreground", className)}
    />
  );
}

export function Diff({ add, del }: { add: number; del: number }) {
  return (
    <span className="whitespace-nowrap text-[12.5px]">
      <span className="text-emerald-700 dark:text-emerald-400">+{add}</span>{" "}
      <span className="text-red-600 dark:text-red-400">−{del}</span>
    </span>
  );
}

/** Minutes → "now" · "12m" · "2h" · "3d". */
export const ago = (m: number) =>
  m < 1
    ? "now"
    : m < 60
      ? `${m}m`
      : m < 1440
        ? `${Math.round(m / 60)}h`
        : `${Math.round(m / 1440)}d`;

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

/** The record open in the side peek. Lists mark its row, so the list you
   came from always shows which item you are looking at. */
export const OpenRecord = createContext<V3RecordRoute | undefined>(undefined);

/** Whether `page:id` is the record open in the side peek. */
export function useOpenRecord() {
  const open = useContext(OpenRecord);
  return (page: V3RecordRoute["page"], id: string) =>
    open?.page === page && open.id === id;
}

/** The side peek's width, for the record inside it. A thread widens it into
   a session (chat on the left, its work on the right) and narrows it back
   beside the list; null when the record is not in a peek. */
export const PeekWidth = createContext<{
  full: boolean;
  setFull: (full: boolean) => void;
} | null>(null);

/** The mark for an open row: a quiet tint and an ink bar on its left edge. */
export const OPEN_ROW =
  "bg-[var(--v3-hover)] shadow-[inset_2px_0_0_var(--foreground)]";

/** A row that opens something: hover tint, no box. Given the record it
   opens, it marks itself while that record is in the side peek. */
export function RowButton({
  onClick,
  children,
  className,
  opens,
}: {
  onClick: () => void;
  children: ReactNode;
  className?: string;
  opens?: V3RecordRoute;
}) {
  const open = useContext(OpenRecord);
  const selected = !!opens && open?.page === opens.page && open.id === opens.id;
  return (
    // A row holds buttons of its own, so it cannot be a <button>.
    <div
      role="button"
      tabIndex={0}
      aria-current={selected || undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) onClick();
      }}
      className={cn(
        "-mx-2 cursor-pointer rounded-md px-2 outline-none transition-colors hover:bg-[var(--v3-hover)] focus-visible:bg-[var(--v3-hover)]",
        className,
        selected && OPEN_ROW,
      )}
    >
      {children}
    </div>
  );
}
