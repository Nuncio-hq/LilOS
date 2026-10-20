import { ArchiveIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { cn } from "../lib/utils";
import type { V3Data } from "./v3-data-types";
import { agentNameOf } from "./v3-model";
import type { V3Actions } from "./v3-page-types";
import type { V3MessageHit, V3Thread } from "./v3-types";

/* ⌘K's Messages group: what was said, found by its text, with the thread and
   the agent it was said to. The search is the app's (`act.searchMessages`);
   without it the group never appears. */

/** Shorter text matches nearly every message; wait for a real word. */
const MIN_CHARS = 2;
const DEBOUNCE_MS = 150;
/** Rows the group shows; the palette is a jump list, not a results page. */
const MAX_HITS = 8;

/** A hit with its thread resolved (a hit in a thread the app cannot open,
    say one whose agent is gone, is dropped: a row that goes nowhere). */
export type FoundMessage = {
  hit: V3MessageHit;
  thread: V3Thread;
  archived: boolean;
};

/** `<mark>`-tagged excerpt → elements. Parsed, never set as HTML: the relay's
    snippet does not escape entities, so only the mark tags are structure. */
function Marks({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let rest = text;
  for (let k = 0; ; k++) {
    const open = rest.indexOf("<mark>");
    const close = open < 0 ? -1 : rest.indexOf("</mark>", open + 6);
    if (open < 0 || close < 0) {
      out.push(rest);
      break;
    }
    if (open) out.push(rest.slice(0, open));
    out.push(
      <mark
        // The excerpt is a fixed string: marks never reorder.
        key={String(k)}
        className="rounded-sm bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-800/60"
      >
        {rest.slice(open + 6, close)}
      </mark>,
    );
    rest = rest.slice(close + 7);
  }
  return <>{out}</>;
}

/** The hits for what is typed. Debounced, and an answer that arrives after
    the text moved on is dropped. A failed search shows nothing (the app has
    already said why). */
export function useMessageHits(
  query: string,
  search: V3Actions["searchMessages"],
  data: V3Data,
): FoundMessage[] {
  const q = query.trim();
  const [raw, setRaw] = useState<{ q: string; hits: V3MessageHit[] }>();
  useEffect(() => {
    if (!search || q.length < MIN_CHARS) {
      setRaw(undefined);
      return;
    }
    let stale = false;
    const t = window.setTimeout(() => {
      search(q).then(
        (hits) => {
          if (!stale) setRaw({ q, hits });
        },
        () => {
          if (!stale) setRaw(undefined);
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
  }, [q, search]);

  const { threads, archivedThreads } = data;
  return useMemo(() => {
    // Only what matches what is typed now: an older answer never lingers.
    if (!raw || raw.q !== q) return [];
    const found: FoundMessage[] = [];
    for (const hit of raw.hits) {
      const live = threads.find((t) => t.id === hit.threadId);
      const thread =
        live ?? archivedThreads?.find((t) => t.id === hit.threadId);
      if (thread) found.push({ hit, thread, archived: !live });
      if (found.length === MAX_HITS) break;
    }
    return found;
  }, [raw, q, threads, archivedThreads]);
}

/** Who said it, as the row names them. A note LilOS wrote itself says LilOS,
    never you (#585). */
function byLabel(data: V3Data, by: string): string {
  if (by === "system") return "LilOS";
  if (by === "you") return data.me;
  return agentNameOf(data, by);
}

export function MessageHitRow({
  found,
  data,
  on,
  onClick,
  onHover,
}: {
  found: FoundMessage;
  data: V3Data;
  on: boolean;
  onClick: () => void;
  onHover: () => void;
}) {
  const { hit, thread, archived } = found;
  return (
    <button
      type="button"
      data-message-hit={hit.messageId}
      onClick={onClick}
      onMouseMove={onHover}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left",
        on && "bg-[var(--v3-hover)]",
      )}
    >
      <span className="line-clamp-2 break-words text-[14px] text-foreground">
        <Marks text={hit.snippet} />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground/70">
        <span className="truncate">
          {byLabel(data, hit.by)} · {hit.at} · in {thread.title}
        </span>
        {archived && (
          <span
            data-archived-hit
            className="flex shrink-0 items-center gap-0.5"
          >
            <ArchiveIcon className="size-3" />
            archived
          </span>
        )}
      </span>
    </button>
  );
}
