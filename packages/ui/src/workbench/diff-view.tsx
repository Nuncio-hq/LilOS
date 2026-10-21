import { ChevronRightIcon, MessageSquarePlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import type { Diff } from "../types";
import { CommentEditor, CommentNote } from "./diff-comment-rows";
import {
  anchorFor,
  anchorRow,
  commentable,
  coversRow,
  type DiffCommentsApi,
  type DiffRow,
  parsePatch,
} from "./diff-rows";
import { OpenPathButton } from "./open-path";
import { AddDel, CARD } from "./wb-bits";
import type { OpenMenuFor } from "./ws-badges";

/* The +added −removed pair; step rows and the PR header share the v3 count. */
export function DiffStat({ add, del }: { add: number; del: number }) {
  return <AddDel add={add} del={del} />;
}

export function DiffView({
  d,
  collapsible = true,
  defaultOpen = true,
  openMenu,
  onOpenLine,
  comments,
}: {
  d: Diff;
  collapsible?: boolean;
  /* Where the file starts: open (rows painted) or collapsed to its header. */
  defaultOpen?: boolean;
  /* Open/reveal menu on the file header + per-row open-at-line on the new
     line numbers (issue #110); absent → static diff (D-#19). */
  openMenu?: OpenMenuFor;
  onOpenLine?: (line: number) => void;
  /* Review comments on this file's rows (issue #108). Changes tab only —
     absent → no comment affordances at all (D-#19). */
  comments?: DiffCommentsApi;
}) {
  const [open, setOpen] = useState(defaultOpen);
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
        <tr key={i} className="text-muted-foreground">
          <td
            colSpan={3}
            className={cn(
              "border-[var(--v3-line)] px-3.5 py-0.5 text-[11px]",
              i > 0 && "border-t",
            )}
          >
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
          r.kind === "add" && "bg-emerald-500/[0.07]",
          r.kind === "del" && "bg-red-500/[0.07]",
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
            "w-9 select-none border-[var(--v3-line)] border-r px-1.5 text-right align-top text-[11px] text-muted-foreground/70 tabular-nums",
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
          className="relative w-9 select-none border-[var(--v3-line)] border-r px-1.5 text-right align-top text-[11px] text-muted-foreground/70 tabular-nums"
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

  const pathLabel = (
    <span
      title={d.path}
      className="min-w-0 flex-1 truncate font-mono text-[12px]"
    >
      {dir && <span className="text-muted-foreground">{dir}/</span>}
      <span className="text-foreground">{name}</span>
    </span>
  );
  return (
    <div className={cn(CARD, "overflow-hidden")} data-diff={d.path}>
      <div
        className={cn(
          "flex items-center gap-2 px-3.5 py-2 transition-colors hover:bg-[var(--v3-hover)]",
          open && "border-[var(--v3-line)] border-b",
        )}
      >
        {collapsible ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={() => setOpen(!open)}
            aria-label="Toggle file"
            aria-expanded={open}
          >
            <ChevronRightIcon
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
            {pathLabel}
          </button>
        ) : (
          pathLabel
        )}
        {/* Status is the only colour on the header: a letter, not a filled chip. */}
        <span
          className={cn(
            "shrink-0 font-mono font-semibold text-[11px]",
            d.status === "added"
              ? "text-emerald-600 dark:text-emerald-400"
              : d.status === "deleted"
                ? "text-red-600 dark:text-red-400"
                : "text-amber-600 dark:text-amber-400",
          )}
        >
          {d.status === "added" ? "A" : d.status === "deleted" ? "D" : "M"}
        </span>
        <span className="flex shrink-0 items-center gap-2.5">
          {openMenu && (
            <OpenPathButton
              editors={openMenu.editors}
              onOpen={openMenu.onOpen}
              label={`Open ${d.path} in an editor or Finder`}
            />
          )}
          <AddDel add={d.add} del={d.del} />
          {collapsible && (
            <label className="flex cursor-pointer items-center gap-1.5 border-[var(--v3-line)] border-l pl-2.5 text-[12px] text-muted-foreground">
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
        <div className="overflow-x-auto py-1.5 font-mono text-[12px] leading-[1.65]">
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
                    <CommentNote
                      key={c.id}
                      c={c}
                      onEdit={() => {
                        setEditing(c.id);
                        const ri = anchorRow(rows, c);
                        setSel({ lo: ri, hi: ri });
                      }}
                      onDelete={() => comments?.onDelete(c.id)}
                    />
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
