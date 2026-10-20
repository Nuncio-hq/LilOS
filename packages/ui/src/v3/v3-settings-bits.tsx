import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { InlineCodeText } from "../lib/inline-code";
import { cn } from "../lib/utils";
import type { V3Settings } from "./v3-data-types";

/* Small pieces the Settings panes and the Welcome flow share: a switch, a
   segmented choice, a labelled row, and the engine's state with the steps to
   fix it, so the same problem reads the same wherever it shows up. */

/** An action that takes a moment, then reports: "Check again", "Check for
   updates", "Copy". `busy` lasts as long as the action does (it may be a
   promise from the app); `done` keeps its result for `holdMs`, then quiets. A
   rejection means the app has already said what went wrong. */
export function useRun<T>(run: () => T | Promise<T>, holdMs = 1800) {
  const [state, set] = useState<"idle" | "busy" | "done">("idle");
  const [result, setResult] = useState<T>();
  useEffect(() => {
    if (state !== "done") return;
    const t = window.setTimeout(() => set("idle"), holdMs);
    return () => window.clearTimeout(t);
  }, [state, holdMs]);
  const start = () => {
    if (state === "busy") return;
    set("busy");
    void Promise.resolve()
      .then(run)
      .then(
        (r) => {
          setResult(r);
          set("done");
        },
        () => set("idle"),
      );
  };
  return [state, start, result] as const;
}

/** A confirmation that shows for a moment ("Copied"), then goes away. */
export function useFlash(ms = 1800) {
  const [on, set] = useState(false);
  useEffect(() => {
    if (!on) return;
    const t = window.setTimeout(() => set(false), ms);
    return () => window.clearTimeout(t);
  }, [on, ms]);
  return [on, () => set(true)] as const;
}

/** A row that goes somewhere or asks the CEO: plain text and a chevron. */
export function LinkRow({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center justify-between gap-4 border-[var(--v3-line)] border-b py-3 text-left text-[14.5px] text-foreground"
    >
      {children}
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/60 group-hover:text-foreground" />
    </button>
  );
}

export function Switch({
  on,
  onChange,
  label,
  disabled,
  title,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!on)}
      className={cn(
        "relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        on ? "bg-foreground" : "bg-foreground/20",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-[2px] left-[2px] size-3.5 rounded-full bg-background transition-transform",
          on && "translate-x-3",
        )}
      />
    </button>
  );
}

/** One choice out of a few, as a row of text buttons in a hairline frame. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex w-fit max-w-full flex-wrap rounded-[7px] border border-[var(--v3-line)] bg-background p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            "h-[26px] rounded-[5px] px-3 text-[13px] text-muted-foreground transition-colors hover:text-foreground",
            value === o.id && "bg-[var(--v3-soft)] font-medium text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A setting: what it is and what it does on the left, its control on the
   right. Wraps (never overflows) when the pane is narrow. */
export function Row({
  title,
  hint,
  children,
}: {
  title: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-[var(--v3-line)] border-b py-3.5">
      <div className="min-w-0 flex-1 basis-56">
        <div className="text-[14.5px] text-foreground">{title}</div>
        {hint && (
          <div className="mt-0.5 text-[13px] text-muted-foreground">{hint}</div>
        )}
      </div>
      {children && (
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      )}
    </div>
  );
}

/** The engine's state in plain words, with a status dot. */
export function EngineState({ engine }: { engine: V3Settings["engine"] }) {
  const tone = {
    ok: {
      dot: "bg-emerald-500",
      text: "text-muted-foreground",
      word: "Running",
    },
    starting: {
      dot: "bg-stone-400",
      text: "text-muted-foreground",
      word: "Starting…",
    },
    old: {
      dot: "bg-amber-500",
      text: "text-amber-700 dark:text-amber-300",
      word: "Update needed",
    },
    down: {
      dot: "bg-red-500",
      text: "text-red-600 dark:text-red-300",
      word: "Not running",
    },
    missing: {
      dot: "bg-red-500",
      text: "text-red-600 dark:text-red-300",
      word: "Not installed",
    },
  }[engine.state];
  return (
    <span className={cn("flex items-center gap-1.5 text-[13.5px]", tone.text)}>
      <span aria-hidden className={cn("size-1.5 rounded-full", tone.dot)} />
      {tone.word}
    </span>
  );
}

function Cmd({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-[var(--v3-hover)] px-1 py-px font-mono text-[12.5px] text-foreground">
      {children}
    </code>
  );
}

/** What to do about an engine that is not fine; nothing when it is, or
   while it is still coming up. The engine's own words (`problem`) lead when
   it gave any; the generic steps are for a state it said nothing about. */
export function EngineFix({ engine }: { engine: V3Settings["engine"] }) {
  if (engine.state === "ok" || engine.state === "starting") return null;
  if (engine.problem)
    return (
      <p className="mt-3 whitespace-pre-line text-[13.5px] text-muted-foreground">
        <InlineCodeText text={engine.problem} />
      </p>
    );
  const cmd = engine.name.toLowerCase();
  const steps: ReactNode[] =
    engine.state === "old"
      ? [
          <>
            Update {engine.name} to the newest version, the same way you
            installed it{engine.version ? ` (you have ${engine.version})` : ""}.
          </>,
          <>
            Open Terminal and run <Cmd>{cmd} --version</Cmd> to confirm.
          </>,
          <>Come back here and press Check again.</>,
        ]
      : [
          <>
            Install {engine.name} on this Mac, from its website or your package
            manager.
          </>,
          <>
            Open Terminal and run <Cmd>{cmd} --version</Cmd>; it should print a
            version.
          </>,
          <>Come back here and press Check again.</>,
        ];
  return (
    <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[13.5px] text-muted-foreground marker:text-muted-foreground/70">
      {steps.map((s, i) => (
        // Fixed three-step list, never reordered.
        <li key={String(i)}>{s}</li>
      ))}
    </ol>
  );
}
