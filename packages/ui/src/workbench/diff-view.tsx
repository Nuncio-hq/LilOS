import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import type { Diff } from "../types";
import { OpenPathButton } from "./open-path";
import type { OpenMenuFor } from "./ws-badges";

export function DiffStat({ add, del }: { add: number; del: number }) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[12px] tabular-nums">
      <span className="text-emerald-600">+{add}</span>
      <span className={del ? "text-red-600" : "text-muted-foreground/60"}>
        −{del}
      </span>
    </span>
  );
}

/* Unified diff with tinted rows + old/new gutters (GitHub / Devin style) instead of colour-only text. */
export type DiffRow = {
  kind: "hunk" | "add" | "del" | "ctx";
  text: string;
  a?: number;
  b?: number;
};
export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let a = 0,
    b = 0;
  for (const line of patch.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h) {
      a = Number(h[1]);
      b = Number(h[2]);
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (line.startsWith("+"))
      rows.push({ kind: "add", text: line.slice(1), b: b++ });
    else if (line.startsWith("-"))
      rows.push({ kind: "del", text: line.slice(1), a: a++ });
    else rows.push({ kind: "ctx", text: line.slice(1), a: a++, b: b++ });
  }
  return rows;
}

export function DiffView({
  d,
  collapsible = true,
  openMenu,
  onOpenLine,
}: {
  d: Diff;
  collapsible?: boolean;
  /* Open/reveal menu on the file header + per-row open-at-line on the new
     line numbers (issue #110); absent → static diff (D-#19). */
  openMenu?: OpenMenuFor;
  onOpenLine?: (line: number) => void;
}) {
  const [open, setOpen] = useState(true);
  const [viewed, setViewed] = useState(false);
  const slash = d.path.lastIndexOf("/");
  const name = d.path.slice(slash + 1);
  const dir = slash > 0 ? d.path.slice(0, slash) : "";
  const rows = parsePatch(d.patch);
  return (
    <div
      className="overflow-hidden rounded-lg border bg-background"
      data-diff={d.path}
    >
      <div className="flex h-9 items-center gap-2 bg-muted/40 px-2.5 text-[13px]">
        {collapsible && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setOpen(!open)}
            aria-label="Toggle file"
          >
            <ChevronDownIcon
              className={cn(
                "size-3.5 transition-transform",
                !open && "-rotate-90",
              )}
            />
          </button>
        )}
        <span
          className={cn(
            "rounded px-1 font-mono font-semibold text-[10px]",
            d.status === "added"
              ? "bg-emerald-500/10 text-emerald-700"
              : d.status === "deleted"
                ? "bg-red-500/10 text-red-700"
                : "bg-amber-500/10 text-amber-700",
          )}
        >
          {d.status === "added" ? "A" : d.status === "deleted" ? "D" : "M"}
        </span>
        <span className="min-w-0 truncate">
          <span className="font-medium">{name}</span>
          {dir && <span className="ml-1.5 text-muted-foreground">{dir}</span>}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2.5">
          {openMenu && (
            <OpenPathButton
              editors={openMenu.editors}
              onOpen={openMenu.onOpen}
              label={`Open ${d.path} in an editor or Finder`}
            />
          )}
          <DiffStat add={d.add} del={d.del} />
          {collapsible && (
            <label className="flex cursor-pointer items-center gap-1.5 border-l pl-2.5 text-muted-foreground text-xs">
              <input
                type="checkbox"
                className="size-3.5 accent-foreground"
                checked={viewed}
                onChange={(e) => {
                  setViewed(e.target.checked);
                  setOpen(!e.target.checked);
                }}
              />
              Viewed
            </label>
          )}
        </span>
      </div>
      {open && (
        <div className="overflow-x-auto border-t font-mono text-[12px] leading-5">
          <table className="w-full border-collapse">
            <tbody>
              {rows.map((r, i) =>
                r.kind === "hunk" ? (
                  <tr key={i} className="bg-blue-500/[0.06] text-blue-700/80">
                    <td colSpan={3} className="px-3 py-0.5 text-[11px]">
                      {r.text}
                    </td>
                  </tr>
                ) : (
                  <tr
                    key={i}
                    className={cn(
                      r.kind === "add" && "bg-emerald-500/[0.09]",
                      r.kind === "del" && "bg-red-500/[0.09]",
                    )}
                  >
                    <td
                      className={cn(
                        "w-9 select-none border-r px-1.5 text-right align-top text-[11px] text-muted-foreground/70 tabular-nums",
                        r.kind === "add" && "border-l-2 border-l-emerald-500",
                        r.kind === "del" && "border-l-2 border-l-red-500",
                      )}
                    >
                      {r.a ?? ""}
                    </td>
                    <td className="w-9 select-none border-r px-1.5 text-right align-top text-[11px] text-muted-foreground/70 tabular-nums">
                      {onOpenLine && r.b != null ? (
                        <button
                          type="button"
                          className="cursor-pointer text-inherit hover:text-foreground hover:underline"
                          title={`Open ${d.path} at line ${r.b}`}
                          data-openline={r.b}
                          onClick={() => {
                            if (r.b != null) onOpenLine(r.b);
                          }}
                        >
                          {r.b}
                        </button>
                      ) : (
                        (r.b ?? "")
                      )}
                    </td>
                    <td className="whitespace-pre px-3 text-foreground/90">
                      <span
                        className={cn(
                          "mr-2 select-none",
                          r.kind === "add"
                            ? "text-emerald-600"
                            : r.kind === "del"
                              ? "text-red-600"
                              : "text-transparent",
                        )}
                      >
                        {r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}
                      </span>
                      {r.text}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
