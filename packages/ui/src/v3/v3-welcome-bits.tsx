import { CheckIcon, XIcon } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { cn } from "../lib/utils";
import { Spinner } from "./v3-bits";

/* The first-run flow's small parts: a labelled input, a pick-one card, the
   step indicator and one line of the engine check. */

const FIELD =
  "mt-1.5 h-9 w-full rounded-[7px] border border-foreground/15 bg-background px-3 text-[15px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-foreground/40";

export function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <label className="mt-5 block">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className={cn(FIELD, mono && "font-mono text-[14px]")}
      />
    </label>
  );
}

/** One choice among a few, as a card with a title and a quiet line. */
export function Choice({
  on,
  onClick,
  title,
  note,
  icon,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  note?: string;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border px-3.5 py-2.5 text-left transition-colors",
        on
          ? "border-foreground bg-[var(--v3-soft)]"
          : "border-[var(--v3-line)] hover:bg-[var(--v3-hover)]",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span
          className={cn("block truncate text-[14.5px]", on && "font-medium")}
        >
          {title}
        </span>
        {note && (
          <span className="block truncate text-[13px] text-muted-foreground">
            {note}
          </span>
        )}
      </span>
      {on && <CheckIcon className="size-4 shrink-0" />}
    </button>
  );
}

/** The step indicator: numbers joined by hairlines; labels when there is room,
    and the current step's always (it is the step's only title). */
export function Steps({ steps, at }: { steps: string[]; at: number }) {
  return (
    <ol
      aria-label="Steps"
      className="mt-6 mb-8 flex items-center gap-2 text-[13px]"
    >
      {steps.map((s, i) => (
        <li
          key={s}
          aria-current={i === at ? "step" : undefined}
          className={cn(
            "flex items-center gap-2",
            i < steps.length - 1 && "flex-1",
            i === at ? "text-foreground" : "text-muted-foreground/70",
          )}
        >
          <span
            className={cn(
              "grid size-5 shrink-0 place-items-center rounded-full border text-[11.5px]",
              i === at && "border-foreground bg-foreground text-background",
              i < at && "border-foreground/40 text-foreground",
              i > at && "border-[var(--v3-line)]",
            )}
          >
            {i < at ? <CheckIcon className="size-3" /> : i + 1}
          </span>
          <span
            className={cn(
              "whitespace-nowrap",
              i === at ? "font-medium" : "hidden @min-[520px]:inline",
            )}
          >
            {s}
          </span>
          {i < steps.length - 1 && (
            <span aria-hidden className="h-px flex-1 bg-[var(--v3-line)]" />
          )}
        </li>
      ))}
    </ol>
  );
}

/** One line of the engine check: waiting, checking, fine, or a problem. */
export function CheckRow({
  state,
  label,
  result,
}: {
  state: "wait" | "run" | "ok" | "fail";
  label: string;
  result: ReactNode;
}) {
  return (
    <div
      // Test hook: the leg's real state, read by e2e (#589); never a timer.
      data-first-run-step
      data-state={state}
      className="flex items-center gap-3 border-[var(--v3-line)] border-b py-3"
    >
      <span className="grid size-5 shrink-0 place-items-center">
        {state === "run" && <Spinner />}
        {state === "ok" && (
          <CheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" />
        )}
        {state === "fail" && (
          <XIcon className="size-4 text-red-600 dark:text-red-400" />
        )}
        {state === "wait" && (
          <span className="size-3 rounded-full border border-[var(--v3-line)]" />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 text-[14.5px]",
          state === "wait" && "text-muted-foreground/70",
        )}
      >
        {label}
      </span>
      <span className="text-[13.5px] text-muted-foreground">
        {state === "wait" ? "" : state === "run" ? "Checking…" : result}
      </span>
    </div>
  );
}
