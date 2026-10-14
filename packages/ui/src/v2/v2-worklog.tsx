import {
  ChevronRightIcon,
  FileDiffIcon,
  FileTextIcon,
  GlobeIcon,
  ListTreeIcon,
  SearchIcon,
  TerminalIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import type { V2DiffLine, V2Live, V2Msg, V2Step } from "./v2-types";

const ICON: Record<V2Step["kind"], typeof FileTextIcon> = {
  read: FileTextIcon,
  edit: FileDiffIcon,
  bash: TerminalIcon,
  search: SearchIcon,
  web: GlobeIcon,
  task: ListTreeIcon,
};
const VERB: Record<V2Step["kind"], string> = {
  read: "Read",
  edit: "Edited",
  bash: "Ran",
  search: "Searched",
  web: "Browsed",
  task: "Delegated",
};
/* [verb, singular noun, plural noun] for the summary line. */
const PHRASE: Record<V2Step["kind"], [string, string, string]> = {
  read: ["read", "file", "files"],
  edit: ["edited", "file", "files"],
  bash: ["ran", "command", "commands"],
  search: ["ran", "search", "searches"],
  web: ["opened", "page", "pages"],
  task: ["delegated", "task", "tasks"],
};

/* "Edited 3 files, ran 2 commands and 4 other steps": the two most telling
   kinds lead (edits and commands beat reads), the rest are counted. */
export function summarize(steps: V2Step[]): string {
  const order: V2Step["kind"][] = [
    "edit",
    "bash",
    "task",
    "web",
    "search",
    "read",
  ];
  const counts = order
    .map((k) => [k, steps.filter((s) => s.kind === k).length] as const)
    .filter(([, n]) => n > 0);
  const parts = counts.slice(0, 2).map(([k, n]) => {
    const [verb, one, many] = PHRASE[k];
    return `${verb} ${n} ${n === 1 ? one : many}`;
  });
  const rest = counts.slice(2).reduce((n, [, c]) => n + c, 0);
  const text =
    parts.join(", ") +
    (rest ? ` and ${rest} other ${rest === 1 ? "step" : "steps"}` : "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function StepRow({ s }: { s: V2Step }) {
  const Icon = ICON[s.kind];
  return (
    <div className="flex h-7 items-center gap-2.5 text-[12.5px]">
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          s.failed ? "text-red-500" : "text-muted-foreground",
        )}
      />
      <span className="w-14 shrink-0 text-muted-foreground">
        {VERB[s.kind]}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-mono text-[12px]",
          s.failed ? "text-red-600 dark:text-red-400" : "text-foreground/85",
        )}
      >
        {s.target}
      </span>
      {s.add !== undefined && (
        <span className="shrink-0 font-mono text-[11.5px] tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">
            +{s.add}
          </span>{" "}
          <span className="text-red-500">−{s.del ?? 0}</span>
        </span>
      )}
      {s.meta && (
        <span className="shrink-0 text-[11.5px] text-muted-foreground">
          {s.meta}
        </span>
      )}
    </div>
  );
}

/* The work behind one reply, the way a coding agent shows it: one summary
   line, expandable into every tool call. */
export function WorkLog({ steps }: { steps: V2Step[] }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  const failed = steps.filter((s) => s.failed).length;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group flex h-7 w-fit items-center gap-1.5 rounded-md text-[12.5px] text-muted-foreground hover:text-foreground"
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 transition-transform duration-200",
            open && "rotate-90",
          )}
        />
        {summarize(steps)}
        {failed > 0 && <span className="text-red-500">· {failed} failed</span>}
      </button>
      {open && (
        <div className="mt-1 ml-[7px] border-foreground/10 border-l pl-4">
          {steps.map((s, i) => (
            <StepRow key={i} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}

/* What a running agent is doing right now: the current tool call and the
   last lines it printed, like watching a terminal over its shoulder. */
export function LiveStep({ live }: { live: V2Live }) {
  const Icon = ICON[live.step.kind];
  return (
    <div className="overflow-hidden rounded-xl bg-foreground/[0.035] ring-1 ring-foreground/[0.06]">
      <div className="flex h-9 items-center gap-2.5 px-3 text-[12.5px]">
        <span className="lilos-v2-breathe inline-block size-2 shrink-0 rounded-full border-[1.5px] border-work" />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground/85">
          {live.step.target}
        </span>
        <span className="shrink-0 text-[11.5px] text-muted-foreground tabular-nums">
          {live.elapsed}
        </span>
      </div>
      {live.tail && live.tail.length > 0 && (
        <pre className="border-foreground/[0.06] border-t px-3 py-2 font-mono text-[11.5px] text-muted-foreground leading-[1.6]">
          {live.tail.join("\n")}
        </pre>
      )}
    </div>
  );
}

function DiffLines({ lines }: { lines: V2DiffLine[] }) {
  return (
    <pre className="overflow-x-auto py-1.5 font-mono text-[11.5px] leading-[1.65]">
      {lines.map((l, i) => (
        <div
          key={i}
          className={cn(
            "px-3",
            l.kind === "add" &&
              "bg-emerald-500/[0.08] text-emerald-800 dark:text-emerald-300",
            l.kind === "del" &&
              "bg-red-500/[0.07] text-red-800 dark:text-red-300",
            l.kind === "ctx" && "text-muted-foreground",
          )}
        >
          <span className="mr-3 select-none opacity-60">
            {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
          </span>
          {l.text}
        </div>
      ))}
    </pre>
  );
}

/* End of a turn that touched files: which files, how much, and a peek at
   the first one. The full review lives in the Workbench. */
export function ChangesCard({ msg }: { msg: V2Msg }) {
  if (!msg.changes?.length) return null;
  const add = msg.changes.reduce((n, c) => n + c.add, 0);
  const del = msg.changes.reduce((n, c) => n + c.del, 0);
  return (
    <div className="overflow-hidden rounded-xl ring-1 ring-foreground/[0.08]">
      <div className="flex h-9 items-center gap-2 bg-foreground/[0.025] px-3 text-[12.5px]">
        <FileDiffIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">
          {msg.changes.length} {msg.changes.length === 1 ? "file" : "files"}{" "}
          changed
        </span>
        <span className="font-mono text-[11.5px] tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">+{add}</span>{" "}
          <span className="text-red-500">−{del}</span>
        </span>
        <button
          type="button"
          className="ml-auto rounded-md px-2 py-0.5 text-[12px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        >
          Review
        </button>
      </div>
      <div className="divide-y divide-foreground/[0.06]">
        {msg.changes.map((c) => (
          <div
            key={c.path}
            className="flex h-8 items-center gap-2 px-3 text-[12px]"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-foreground/85">
              {c.path}
            </span>
            <span className="shrink-0 font-mono text-[11.5px] tabular-nums">
              <span className="text-emerald-600 dark:text-emerald-400">
                +{c.add}
              </span>{" "}
              <span className="text-red-500">−{c.del}</span>
            </span>
          </div>
        ))}
      </div>
      {msg.preview && (
        <div className="border-foreground/[0.06] border-t">
          <DiffLines lines={msg.preview.lines} />
        </div>
      )}
    </div>
  );
}
