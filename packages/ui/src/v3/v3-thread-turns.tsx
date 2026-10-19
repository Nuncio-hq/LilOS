import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import { Diff, Spinner, STEP_VERB, StepIcon } from "./v3-bits";
import type { V3Step, V3Turn } from "./v3-types";

/* The turns of a thread, newest first. The newest is open with every step;
   older ones fold to one summary line you can open. */

function StepRow({ s }: { s: V3Step }) {
  if (s.kind === "think") {
    return (
      <div className="flex min-h-[31px] items-start gap-2.5 py-1 pl-[18px] text-[13.5px] text-muted-foreground italic">
        <StepIcon kind="think" className="mt-0.5" />
        <span className="min-w-0 flex-1">{s.target}</span>
      </div>
    );
  }
  const tone = s.running
    ? "text-sky-700 dark:text-sky-300"
    : s.failed
      ? "text-red-600 dark:text-red-300"
      : "";
  return (
    <div className="flex min-h-[31px] items-center gap-2.5 pl-[18px] text-[13.5px]">
      {s.running ? (
        <Spinner className="size-[15px]" />
      ) : (
        <StepIcon
          kind={s.kind}
          className={s.failed ? "text-red-500 dark:text-red-400" : undefined}
        />
      )}
      <span className={cn("w-[62px] shrink-0 text-muted-foreground", tone)}>
        {s.running && s.kind === "run" ? "Running" : STEP_VERB[s.kind]}
      </span>
      <span
        className={cn("min-w-0 flex-1 truncate font-mono text-[12.5px]", tone)}
      >
        {s.target}
      </span>
      {s.add !== undefined && s.del !== undefined ? (
        <Diff add={s.add} del={s.del} />
      ) : (
        s.meta && (
          <span
            className={cn(
              "whitespace-nowrap text-[12.5px] text-muted-foreground/70",
              tone,
            )}
          >
            {s.meta}
          </span>
        )
      )}
    </div>
  );
}

function TurnBlock({
  turn,
  open,
  onToggle,
}: {
  turn: V3Turn;
  open: boolean;
  onToggle: () => void;
}) {
  const foldable = !!turn.steps?.length;
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  const head = (
    <>
      <Chevron
        className={cn(
          "size-3 shrink-0 text-muted-foreground/70",
          !foldable && "invisible",
        )}
      />
      <span className="font-semibold">Turn {turn.n}</span>
      <span className="font-normal text-[13px] text-muted-foreground/70">
        · {turn.from} · {turn.took}
      </span>
    </>
  );
  return (
    <div className="mt-6">
      {foldable ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="-ml-1 flex min-h-7 items-center gap-2 rounded px-1 text-[14px] hover:bg-[var(--v3-hover)]"
        >
          {head}
        </button>
      ) : (
        <div className="-ml-1 flex min-h-7 items-center gap-2 px-1 text-[14px]">
          {head}
        </div>
      )}
      {open && foldable ? (
        <div className="mt-0.5">
          {turn.steps?.map((s, i) => (
            // Steps are an append-only log, so the index is their identity.
            <StepRow key={i} s={s} />
          ))}
        </div>
      ) : (
        <div className="pl-[18px] text-[13.5px] text-muted-foreground">
          {turn.summary ?? `${turn.steps?.length ?? 0} steps`}
          {turn.facts && (
            <span className="block text-[12.5px] text-muted-foreground/70">
              {turn.facts}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function Turns({ turns }: { turns: V3Turn[] }) {
  // Only the newest turn starts open; the rest are one line each.
  const [open, setOpen] = useState<Set<number>>(
    () => new Set(turns[0] ? [turns[0].n] : []),
  );
  const toggle = (n: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(n)) next.add(n);
      return next;
    });
  return (
    <>
      {turns.map((t) => (
        <TurnBlock
          key={t.n}
          turn={t}
          open={open.has(t.n)}
          onToggle={() => toggle(t.n)}
        />
      ))}
    </>
  );
}
