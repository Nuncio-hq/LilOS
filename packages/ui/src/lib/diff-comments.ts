import { useCallback, useSyncExternalStore } from "react";
import type { Diff, DiffComment } from "../types";

/* Diff-line review comments (issue #108, prototype #364). A module-level
   store keyed by scope (thread.session): Workbench tabs unmount their
   content on switch (Radix), so React state inside DiffView would forget
   every pinned note on tab flip — the keyed store outlives the remount
   (same rationale as lib/block-state.ts, D-#320). All writes publish new
   arrays so useSyncExternalStore snapshots stay reference-stable. */

const EMPTY: DiffComment[] = [];
const CAP = 50; // scopes
const lists = new Map<string, DiffComment[]>();
const subs = new Map<string, Set<() => void>>();
let seq = 0;

const listFor = (scope: string): DiffComment[] => lists.get(scope) ?? EMPTY;

function publish(scope: string, next: DiffComment[]): void {
  lists.delete(scope); // refresh recency
  lists.set(scope, next);
  while (lists.size > CAP) {
    const oldest = lists.keys().next().value;
    if (oldest === undefined) break;
    lists.delete(oldest);
  }
  for (const fn of subs.get(scope) ?? []) fn();
}

export function useDiffComments(scope: string): {
  comments: DiffComment[];
  add: (c: Omit<DiffComment, "id">) => void;
  edit: (id: string, text: string) => void;
  remove: (id: string) => void;
  /** Sent: every pending note becomes a resolved marker fingerprinted to
      the patch it quoted (AC-4). Returns the comments that were sent. */
  resolveAll: (patches: Map<string, string>) => DiffComment[];
  /** The diff moved: drop resolved markers whose file's patch changed,
      pending notes whose file left the diff or whose anchor vanished. */
  prune: (diffs: Diff[]) => void;
} {
  const comments = useSyncExternalStore(
    useCallback(
      (on) => {
        const s = subs.get(scope) ?? new Set<() => void>();
        s.add(on);
        subs.set(scope, s);
        return () => {
          s.delete(on);
        };
      },
      [scope],
    ),
    () => listFor(scope),
  );
  const add = useCallback(
    (c: Omit<DiffComment, "id">) => {
      publish(scope, [
        ...listFor(scope),
        { ...c, id: `dc-${Date.now().toString(36)}-${(seq++).toString(36)}` },
      ]);
    },
    [scope],
  );
  const edit = useCallback(
    (id: string, text: string) => {
      publish(
        scope,
        listFor(scope).map((c) => (c.id === id ? { ...c, text } : c)),
      );
    },
    [scope],
  );
  const remove = useCallback(
    (id: string) => {
      publish(
        scope,
        listFor(scope).filter((c) => c.id !== id),
      );
    },
    [scope],
  );
  const resolveAll = useCallback(
    (patches: Map<string, string>) => {
      const pending = listFor(scope).filter((c) => !c.resolved);
      publish(
        scope,
        listFor(scope).map((c) =>
          c.resolved ? c : { ...c, resolved: true, patch: patches.get(c.path) },
        ),
      );
      return pending;
    },
    [scope],
  );
  const prune = useCallback(
    (diffs: Diff[]) => {
      const now = new Map(diffs.map((d) => [d.path, d]));
      const next = listFor(scope).filter((c) => {
        const d = now.get(c.path);
        if (!d) return false; // file left the diff entirely
        if (c.resolved) return c.patch === d.patch;
        return anchorVisible(c, d.patch);
      });
      const cur = listFor(scope);
      if (next.length !== cur.length || next.some((c, i) => c !== cur[i]))
        publish(scope, next);
    },
    [scope],
  );
  return { comments, add, edit, remove, resolveAll, prune };
}

/* Does the current patch still show the note's anchor? A comment is
   visible while both endpoint lines exist on its gutter side (interior
   lines may move — the quote was snapshotted at pin time anyway). */
export function anchorVisible(c: DiffComment, patch: string): boolean {
  const seen = new Set<number>();
  let a = 0;
  let b = 0;
  for (const line of patch.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      a = Number(h[1]);
      b = Number(h[2]);
      continue;
    }
    if (line.startsWith("+")) {
      if (c.side === "b") seen.add(b);
      b++;
    } else if (line.startsWith("-")) {
      if (c.side === "a") seen.add(a);
      a++;
    } else {
      seen.add(c.side === "a" ? a : b);
      a++;
      b++;
    }
    if (seen.has(c.start) && seen.has(c.end)) return true;
  }
  return false;
}

/* The one user message Send to agent posts (AC-2): every comment with
   `path:line` (-`end` on a range) + the code it pinned, then the note. */
export function diffCommentsMessage(list: DiffComment[]): string {
  const parts = list.map((c) => {
    const where =
      c.start === c.end
        ? `${c.path}:${c.start}`
        : `${c.path}:${c.start}-${c.end}`;
    const quote = c.lines.join("\n");
    return `${where}\n${quote}\n${c.text}`;
  });
  return `Review comments on the diff:\n\n${parts.join("\n\n")}`;
}

/* AC-3: the same steer-vs-queue rule the composer rides — running turn +
   engine `steer` capability → session.steer, running without it → queue
   as the next prompt, idle → a fresh prompt. The web app never branches
   on this at send time (the harness decides inside messages.post), but
   the label + the tests do. */
export function diffSendRoute(running: boolean, canSteer: boolean) {
  return !running ? "prompt" : canSteer ? "steer" : "queue";
}
