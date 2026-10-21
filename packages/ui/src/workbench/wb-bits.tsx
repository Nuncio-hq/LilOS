import { CheckIcon } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/utils";

/* The small pieces every workbench tab shares, in the v3 voice: hairline
   cards instead of boxed panels, one quiet sentence for an empty tab, flat
   7px buttons. The prototype's work panel renders the same tabs, so these
   are the only place the look is decided. */

/** A hairline card — diff files, PR header, job rows. */
export const CARD = "rounded-[10px] border border-[var(--v3-line)]";

/** A text field that sits on a tab's body or bar. */
export const FIELD =
  "h-7 min-w-0 rounded-[7px] border border-foreground/15 bg-background px-2.5 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-foreground/30";

/** Tab body padding — the prototype's Panel: 20px sides, 20px top. */
export const PANEL = "px-5 pt-5 pb-8";

/** One muted sentence — what an empty tab says. */
export function Quiet({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & Omit<
  React.HTMLAttributes<HTMLParagraphElement>,
  "children" | "className"
>) {
  return (
    <p
      className={cn("text-[13.5px] text-muted-foreground/70", className)}
      {...rest}
    >
      {children}
    </p>
  );
}

/** An empty tab: a padded `Quiet` line, plus an optional next step below it. */
export function WbEmpty({
  children,
  action,
  ...rest
}: {
  children: ReactNode;
  action?: ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "children">) {
  return (
    <div className={cn(PANEL, "space-y-3")} {...rest}>
      <Quiet>{children}</Quiet>
      {action}
    </div>
  );
}

/** The prototype's flat button: 26px, 7px radius, hairline border; `primary`
    inverts to ink. Takes any native button attribute (data hooks, titles). */
export function WbBtn({
  primary,
  className,
  type = "button",
  ...rest
}: { primary?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border px-2.5 font-medium text-[13px] transition-[background,transform] enabled:active:scale-[0.97] disabled:cursor-default disabled:opacity-55 [&_svg]:size-3.5",
        primary
          ? "border-foreground bg-foreground text-background enabled:hover:bg-foreground/85"
          : "border-foreground/15 bg-background text-foreground enabled:hover:bg-[var(--v3-hover)]",
        className,
      )}
      {...rest}
    />
  );
}

/** A section label inside a panel — 12px muted, with an optional count. */
export function WbHead({
  children,
  count,
  className,
}: {
  children: ReactNode;
  count?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-2 flex justify-between font-medium text-[12px] text-muted-foreground/70",
        className,
      )}
    >
      {children}
      {count && <span className="font-normal">{count}</span>}
    </div>
  );
}

/** +added −removed, the v3 diff count: quiet colour on the numbers only. */
export function AddDel({ add, del }: { add: number; del: number }) {
  return (
    <span className="shrink-0 font-mono text-[12px] tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{add}</span>{" "}
      <span className="text-red-600 dark:text-red-400">−{del}</span>
    </span>
  );
}

/** A step's state as the prototype draws it: done = ink dot with a check,
    current = sky ring + dot, todo (or cancelled) = muted ring. */
export function PlanDot({ state }: { state: "done" | "current" | "todo" }) {
  if (state === "done")
    return (
      <span className="grid size-[15px] shrink-0 place-items-center rounded-full bg-foreground text-background">
        <CheckIcon className="size-[10px]" strokeWidth={3} />
      </span>
    );
  return (
    <span
      className={cn(
        "grid size-[15px] shrink-0 place-items-center rounded-full border-[1.5px]",
        state === "current"
          ? "border-sky-600 dark:border-sky-400"
          : "border-muted-foreground/40",
      )}
    >
      {state === "current" && (
        <span className="size-1.5 rounded-full bg-sky-600 dark:bg-sky-400" />
      )}
    </span>
  );
}

/** A cold mount's first read round is still in flight: hold the aside. */
export function WbReading({ cwd }: { cwd: string }) {
  return (
    <div
      data-wb-probing
      className="flex min-h-0 flex-1 items-center justify-center gap-1.5 p-6 text-center text-muted-foreground text-xs"
    >
      Reading <span className="font-mono">{cwd}</span>…
    </div>
  );
}

/** A settled round with no answered method: one plain line, not an empty
    tab strip. */
export function WbNothingToShow({
  folderless,
  cwd,
}: {
  folderless: boolean;
  cwd: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-muted-foreground text-xs">
      {folderless ? (
        <p>
          Nothing to show — a process, helper or plan lists here once the thread
          has one.
        </p>
      ) : (
        <p>
          Nothing to show — the host has no answer for{" "}
          <span className="font-mono">{cwd}</span>.
        </p>
      )}
    </div>
  );
}
