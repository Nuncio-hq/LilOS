import {
  CheckIcon,
  ChevronDownIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useUiLayer } from "../chat/ui-layers";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import type { Diff, DiffComment } from "../types";
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

const rowMarker = (r: DiffRow) =>
  r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ";

/* Review comments pinned on diff lines (issue #108, prototype #364).
   Opt-in: only callers that wire `comments` get the affordances — a
   control renders only when its handler is passed (D-#19), so step-row
   and PR-panel diffs stay read-only. */
export type DiffCommentsApi = {
  /** This file's comments, pending + resolved. */
  list: DiffComment[];
  onAdd: (c: Omit<DiffComment, "id">) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
};

/* Rows a comment can pin to (hunks are headers, not code). */
const commentable = (r: DiffRow) => r.kind !== "hunk";

/* The anchor a selection of rows [lo..hi] produces: numbered on the side
   the last selected row carries (deletes anchor on the old-file gutter),
   quoting every selected row verbatim with its diff marker. */
function anchorFor(
  rows: DiffRow[],
  lo: number,
  hi: number,
): Pick<DiffComment, "side" | "start" | "end" | "lines"> {
  const sel = rows.slice(lo, hi + 1).filter(commentable);
  const last = sel[sel.length - 1]!;
  const side = last.b != null ? ("b" as const) : ("a" as const);
  const nums = sel
    .map((r) => (side === "b" ? r.b : r.a))
    .filter((n): n is number => n != null);
  return {
    side,
    start: Math.min(...nums),
    end: Math.max(...nums),
    lines: sel.map((r) => `${rowMarker(r)}${r.text}`),
  };
}

/* The row a comment renders under: the row carrying its end line on its
   side. Comments always anchor below their last pinned line. */
function anchorRow(rows: DiffRow[], c: DiffComment): number {
  let hit = -1;
  rows.forEach((r, i) => {
    const n = c.side === "a" ? r.a : r.b;
    if (n != null && n === c.end) hit = i;
  });
  return hit;
}

/* Every row a comment's span touches on its numbered side — the marker
   AC-1 puts on covered lines (pending amber, sent sky). */
function coversRow(c: DiffComment, r: DiffRow): boolean {
  const n = c.side === "a" ? r.a : r.b;
  return n != null && n >= c.start && n <= c.end;
}

function CommentEditor({
  rows,
  lo,
  hi,
  initial,
  onSubmit,
  onClose,
}: {
  rows: DiffRow[];
  lo: number;
  hi: number;
  /** The comment being edited — its own span labels the editor. */
  initial?: DiffComment;
  onSubmit: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial?.text ?? "");
  /* Esc must close only this editor, not the Focus/panel layer beneath —
     register on the layer stack so dispatch stops here (#576). The
     textarea's own Esc → onClose stays as a harmless duplicate. */
  useUiLayer({ onEscape: onClose });
  const a = initial ?? anchorFor(rows, lo, hi);
  const range =
    a.start === a.end ? `line ${a.start}` : `lines ${a.start}–${a.end}`;
  return (
    <tr data-comment-editor>
      <td colSpan={3} className="border-t bg-background p-0 font-sans">
        <div className="border-l-2 border-l-amber-500 bg-amber-500/[0.06] px-3 py-2">
          <div className="mb-1 text-[11px] text-muted-foreground">
            Comment on {range}
          </div>
          <Textarea
            autoFocus
            data-comment-input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                text.trim() && onSubmit(text.trim());
            }}
            placeholder="Ask or note something about this code…"
            className="min-h-14 border bg-background text-xs"
          />
          <div className="mt-1.5 flex items-center gap-1.5">
            <Button
              size="xs"
              data-comment-save
              disabled={!text.trim()}
              onClick={() => onSubmit(text.trim())}
            >
              {initial ? "Save" : "Comment"}
            </Button>
            <Button variant="ghost" size="xs" onClick={onClose}>
              Cancel
            </Button>
            <span className="ml-auto text-[10px] text-muted-foreground/70">
              ⌘⏎ sends · Esc cancels
            </span>
          </div>
        </div>
      </td>
    </tr>
  );
}

export function DiffView({
  d,
  collapsible = true,
  openMenu,
  onOpenLine,
  comments,
}: {
  d: Diff;
  collapsible?: boolean;
  /* Open/reveal menu on the file header + per-row open-at-line on the new
     line numbers (issue #110); absent → static diff (D-#19). */
  openMenu?: OpenMenuFor;
  onOpenLine?: (line: number) => void;
  /* Review comments on this file's rows (issue #108). Changes tab only —
     absent → no comment affordances at all (D-#19). */
  comments?: DiffCommentsApi;
}) {
  const [open, setOpen] = useState(true);
  const [viewed, setViewed] = useState(false);
  /* Selection being edited: row indexes [lo, hi]. `drag` = the row the
     gutter drag began on; while the mouse is down the range follows
     mouseenter. */
  const [sel, setSel] = useState<{ lo: number; hi: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const dragFrom = useRef<number | null>(null);
  const dragged = useRef(false);
  /* While the gutter drag runs, only the highlight follows the mouse — the
     editor opens on mouseup, or popping it mid-drag shifts the rows under
     the pointer and the range stops growing. */
  const [dragging, setDragging] = useState(false);
  const slash = d.path.lastIndexOf("/");
  const name = d.path.slice(slash + 1);
  const dir = slash > 0 ? d.path.slice(0, slash) : "";
  const rows = parsePatch(d.patch);

  /* End the gutter drag even when the mouse lands outside the table. */
  useEffect(() => {
    const up = () => {
      if (dragFrom.current != null && !dragged.current)
        setSel({ lo: dragFrom.current, hi: dragFrom.current });
      dragFrom.current = null;
      setDragging(false);
      /* `dragged` stays true through the click that follows mouseup —
         clickLine consumes it so a finished range doesn't collapse to
         the line the mouse happened to land on. */
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const list = comments?.list ?? [];
  const underRow = (i: number) => list.filter((c) => anchorRow(rows, c) === i);

  const pick = (i: number) => {
    setEditing(null);
    setSel({ lo: i, hi: i });
  };
  const submit = (text: string) => {
    if (!sel || !comments) return;
    if (editing) {
      comments.onEdit(editing, text);
      setEditing(null);
    } else {
      comments.onAdd({
        path: d.path,
        text,
        ...anchorFor(rows, sel.lo, sel.hi),
      });
    }
    setSel(null);
  };

  const rowTr = (r: DiffRow, i: number) => {
    if (r.kind === "hunk")
      return (
        <tr key={i} className="bg-blue-500/[0.06] text-blue-700/80">
          <td colSpan={3} className="px-3 py-0.5 text-[11px]">
            {r.text}
          </td>
        </tr>
      );
    const inSel = sel && i >= sel.lo && i <= sel.hi;
    const anchor = comments
      ? list.some((c) => !c.resolved && coversRow(c, r))
        ? "pending"
        : list.some((c) => c.resolved && coversRow(c, r))
          ? "resolved"
          : null
      : null;
    const clickLine = () => {
      /* A click that ends a gutter drag or one that follows selecting
         code text is not a pick — it's the end of a selection gesture. */
      if (dragged.current) {
        dragged.current = false;
        return;
      }
      const s = window.getSelection();
      if (s && !s.isCollapsed) return;
      pick(i);
    };
    return (
      <tr
        key={i}
        data-diff-line={i}
        {...(anchor ? { "data-comment-anchor": anchor } : {})}
        className={cn(
          "group",
          r.kind === "add" && "bg-emerald-500/[0.09]",
          r.kind === "del" && "bg-red-500/[0.09]",
          inSel && "bg-amber-500/[0.14]",
          comments && "cursor-pointer",
        )}
        onClick={comments ? clickLine : undefined}
        onMouseEnter={() => {
          if (dragFrom.current != null && commentable(r)) {
            dragged.current = true;
            setSel({
              lo: Math.min(dragFrom.current, i),
              hi: Math.max(dragFrom.current, i),
            });
          }
        }}
      >
        <td
          className={cn(
            "w-9 select-none border-r px-1.5 text-right align-top text-[11px] text-muted-foreground/70 tabular-nums",
            r.kind === "add" && "border-l-2 border-l-emerald-500",
            r.kind === "del" && "border-l-2 border-l-red-500",
            comments && "cursor-ns-resize",
          )}
          onMouseDown={
            comments
              ? (e) => {
                  e.preventDefault();
                  dragFrom.current = i;
                  dragged.current = false;
                  setDragging(true);
                  setSel({ lo: i, hi: i });
                }
              : undefined
          }
        >
          {comments ? (
            <span className="relative inline-block">
              <MessageSquarePlusIcon
                className="pointer-events-none absolute -left-3.5 -top-0.5 hidden size-3 text-amber-600 group-hover:block"
                aria-hidden
              />
              {r.a ?? ""}
            </span>
          ) : (
            (r.a ?? "")
          )}
        </td>
        <td
          className="relative w-9 select-none border-r px-1.5 text-right align-top text-[11px] text-muted-foreground/70 tabular-nums"
          onMouseDown={
            comments
              ? (e) => {
                  e.preventDefault();
                  dragFrom.current = i;
                  dragged.current = false;
                  setDragging(true);
                  setSel({ lo: i, hi: i });
                }
              : undefined
          }
        >
          {anchor && (
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute left-1 top-1/2 size-1.5 -translate-y-1/2 rounded-full",
                anchor === "pending" ? "bg-amber-500" : "bg-sky-500",
              )}
            />
          )}
          {onOpenLine && r.b != null ? (
            <button
              type="button"
              className="cursor-pointer text-inherit hover:text-foreground hover:underline"
              title={`Open ${d.path} at line ${r.b}`}
              data-openline={r.b}
              onClick={(e) => {
                e.stopPropagation();
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
    );
  };

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
              {rows.map((r, i) => {
                const commentsHere = comments ? underRow(i) : [];
                return [
                  rowTr(r, i),
                  ...(comments && sel && sel.hi === i && !editing && !dragging
                    ? [
                        <CommentEditor
                          key="editor"
                          rows={rows}
                          lo={sel.lo}
                          hi={sel.hi}
                          onSubmit={submit}
                          onClose={() => setSel(null)}
                        />,
                      ]
                    : []),
                  ...(comments && sel && sel.hi === i && editing
                    ? [
                        <CommentEditor
                          key="editing"
                          rows={rows}
                          lo={sel.lo}
                          hi={sel.hi}
                          initial={list.find((c) => c.id === editing)}
                          onSubmit={submit}
                          onClose={() => {
                            setEditing(null);
                            setSel(null);
                          }}
                        />,
                      ]
                    : []),
                  ...commentsHere.map((c) => (
                    <tr
                      key={c.id}
                      data-comment={c.id}
                      {...(c.resolved ? { "data-resolved": true } : {})}
                    >
                      <td colSpan={3} className="border-t p-0 font-sans">
                        <div
                          className={cn(
                            "flex items-start gap-2 px-3 py-1.5 text-xs",
                            c.resolved
                              ? "border-l-2 border-l-sky-500/60 bg-sky-500/[0.05] text-muted-foreground"
                              : "border-l-2 border-l-amber-500 bg-amber-500/[0.06]",
                          )}
                        >
                          {c.resolved ? (
                            <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-sky-600" />
                          ) : (
                            <MessageSquarePlusIcon className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                          )}
                          <div className="min-w-0 flex-1">
                            {c.resolved && (
                              <span
                                data-sent-pill
                                className="mr-2 rounded-full bg-sky-500/15 px-1.5 py-px font-medium text-[10px] text-sky-700 dark:text-sky-300"
                              >
                                {c.via === "steer"
                                  ? "Sent · steered"
                                  : c.via === "queue"
                                    ? "Sent · queued"
                                    : "Sent"}
                              </span>
                            )}
                            <span className="mr-2 font-mono text-[10px] text-muted-foreground">
                              {c.start === c.end
                                ? `${c.path}:${c.start}`
                                : `${c.path}:${c.start}–${c.end}`}
                            </span>
                            {c.resolved ? (
                              <span className="italic">{c.text}</span>
                            ) : (
                              <span className="whitespace-pre-wrap">
                                {c.text}
                              </span>
                            )}
                          </div>
                          {!c.resolved && (
                            <span className="-mt-1 flex shrink-0 gap-0.5">
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                title="Edit comment"
                                data-comment-edit
                                onClick={() => {
                                  setEditing(c.id);
                                  const ri = anchorRow(rows, c);
                                  setSel({ lo: ri, hi: ri });
                                }}
                              >
                                <PencilIcon />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                title="Delete comment"
                                data-comment-delete
                                onClick={() => comments?.onDelete(c.id)}
                              >
                                <Trash2Icon />
                              </Button>
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
