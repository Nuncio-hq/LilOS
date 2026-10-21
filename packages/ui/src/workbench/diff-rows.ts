import type { Diff, DiffComment } from "../types";

/* A unified diff as rows (old/new line numbers, kind) and where review
   comments pin to them — the logic `DiffView` draws. */

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
export const commentable = (r: DiffRow) => r.kind !== "hunk";

/* The anchor a selection of rows [lo..hi] produces: numbered on the side
   the last selected row carries (deletes anchor on the old-file gutter),
   quoting every selected row verbatim with its diff marker. */
export function anchorFor(
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
export function anchorRow(rows: DiffRow[], c: DiffComment): number {
  let hit = -1;
  rows.forEach((r, i) => {
    const n = c.side === "a" ? r.a : r.b;
    if (n != null && n === c.end) hit = i;
  });
  return hit;
}

/* Every row a comment's span touches on its numbered side — the marker
   AC-1 puts on covered lines (pending amber, sent sky). */
export function coversRow(c: DiffComment, r: DiffRow): boolean {
  const n = c.side === "a" ? r.a : r.b;
  return n != null && n >= c.start && n <= c.end;
}

/* How many diff rows the Changes tab paints open before the rest of the
   files start collapsed. Every row is ~8 DOM nodes: a working tree with
   hundreds of changed files painted whole (the repo mid-refactor) is
   ~600k nodes — a multi-second main-thread stall in which no click, tab
   pick or scroll lands. Collapsed files keep their header (name, stat,
   Viewed) and open on the chevron. */
const OPEN_ROW_BUDGET = 1500;

/** The files that start open: in order, until the budget of rows is spent
    (the first always opens, however long). */
export function openPaths(diffs: Diff[]): Set<string> {
  const open = new Set<string>();
  let rows = 0;
  for (const d of diffs) {
    if (rows >= OPEN_ROW_BUDGET) break;
    open.add(d.path);
    rows += d.patch.split("\n").length;
  }
  return open;
}
