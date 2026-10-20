import {
  FileDiffIcon,
  GitPullRequestIcon,
  ImageIcon,
  SheetIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import { Btn, Diff } from "./v3-bits";
import type { V3PageProps } from "./v3-page-types";
import type { V3Attachment } from "./v3-types";

/* What a reply carries besides prose: calm bordered cards under the answer.
   Images sit two to a row; every other card takes the full width. */

type Of<K extends V3Attachment["kind"]> = Extract<V3Attachment, { kind: K }>;
type Card = Exclude<V3Attachment, { kind: "image" }>;

const CARD = "rounded-[10px] border border-[var(--v3-line)]";
const SHOWN = 8;

function PrCard({
  pr,
  ticketId,
  go,
}: {
  pr: Of<"pr">;
  ticketId?: string;
  go: V3PageProps["go"];
}) {
  return (
    <div className={cn(CARD, "flex items-center gap-3 px-3.5 py-3")}>
      <GitPullRequestIcon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] text-foreground">
          <span className="text-muted-foreground/70">#{pr.num}</span>{" "}
          <span className="font-medium">{pr.title}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2.5 text-[12.5px] text-muted-foreground">
          <span className="truncate font-mono text-[12px]">{pr.branch}</span>
          <Diff add={pr.add} del={pr.del} />
        </div>
      </div>
      {ticketId && (
        <Btn small onClick={() => go({ page: "ticket", id: ticketId })}>
          Open ticket
        </Btn>
      )}
    </div>
  );
}

function DiffCard({ d }: { d: Of<"diff"> }) {
  const [all, setAll] = useState(false);
  const lines = all ? d.lines : d.lines.slice(0, SHOWN);
  const more = d.lines.length - SHOWN;
  return (
    <div className={cn(CARD, "overflow-hidden")}>
      <div className="flex items-center gap-2.5 border-[var(--v3-line)] border-b px-3.5 py-2">
        <FileDiffIcon className="size-4 shrink-0 text-muted-foreground" />
        <span
          title={d.path}
          className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground"
        >
          {d.path}
        </span>
        <Diff add={d.add} del={d.del} />
      </div>
      <div className="overflow-x-auto">
        {/* min-w-max keeps every tinted row as wide as the longest line. */}
        <div className="min-w-max py-1.5 font-mono text-[12px] leading-[1.65]">
          {lines.map((l, i) => (
            <div
              key={i}
              className={cn(
                "flex gap-2 px-3.5",
                l.kind === "add" && "bg-emerald-50/70 dark:bg-emerald-400/10",
                l.kind === "del" && "bg-red-50/70 dark:bg-red-400/10",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "w-2.5 shrink-0 select-none text-center",
                  l.kind === "add" && "text-emerald-700 dark:text-emerald-400",
                  l.kind === "del" && "text-red-600 dark:text-red-400",
                )}
              >
                {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
              </span>
              <span className="whitespace-pre text-foreground/90">
                {l.text}
              </span>
            </div>
          ))}
        </div>
      </div>
      {more > 0 && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="w-full border-[var(--v3-line)] border-t px-3.5 py-1.5 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground"
        >
          {all
            ? "Show less"
            : `Show ${more} more ${more === 1 ? "line" : "lines"}`}
        </button>
      )}
    </div>
  );
}

/* A stand-in for the picture: the prototype has no real screenshots. */
function ImageTile({ a }: { a: Of<"image"> }) {
  return (
    <figure className="relative m-0 grid aspect-[16/10] place-items-center overflow-hidden rounded-[10px] border border-[var(--v3-line)] bg-[var(--v3-soft)]">
      <ImageIcon
        className="size-6 text-muted-foreground/60"
        strokeWidth={1.5}
      />
      <figcaption className="absolute inset-x-0 bottom-0 truncate px-3 py-2 text-[12.5px] text-muted-foreground">
        {a.label}
      </figcaption>
    </figure>
  );
}

function SheetCard({ s }: { s: Of<"sheet"> }) {
  return (
    <div className={cn(CARD, "flex items-center gap-3 px-3.5 py-3")}>
      <SheetIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-medium text-[14px] text-foreground">
        {s.name}
      </span>
      <span className="shrink-0 text-[12.5px] text-muted-foreground/70">
        {s.rows} {s.rows === 1 ? "row" : "rows"}
      </span>
    </div>
  );
}

export function Attachments({
  items,
  ticketId,
  go,
}: {
  items: V3Attachment[];
  /** The thread's ticket; a PR card offers to open it. */
  ticketId?: string;
  go: V3PageProps["go"];
}) {
  // Neighbouring images share one two-column grid.
  const blocks: (Card | Of<"image">[])[] = [];
  for (const a of items) {
    if (a.kind !== "image") {
      blocks.push(a);
      continue;
    }
    const last = blocks.at(-1);
    if (Array.isArray(last)) last.push(a);
    else blocks.push([a]);
  }
  return (
    <div className="mt-3 space-y-2.5">
      {blocks.map((b, i) => {
        if (Array.isArray(b)) {
          return (
            <div key={i} className="grid grid-cols-2 gap-2.5">
              {b.map((a, j) => (
                <ImageTile key={j} a={a} />
              ))}
            </div>
          );
        }
        if (b.kind === "pr")
          return <PrCard key={i} pr={b} ticketId={ticketId} go={go} />;
        if (b.kind === "diff") return <DiffCard key={i} d={b} />;
        return <SheetCard key={i} s={b} />;
      })}
    </div>
  );
}
