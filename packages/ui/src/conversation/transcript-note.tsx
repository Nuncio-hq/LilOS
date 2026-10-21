import { cn } from "../lib/utils";
import type { TranscriptNote } from "../types";

/* #532: one note visual per kind, shared so Focus and ThreadView can't
   drift. The VIEW picks the position — "trimmed" heads the transcript (it
   describes history missing above the first entry), "unavailable" keeps
   the dashed tail box (#28 is about the live tail). The trimmed divider is
   centered low-emphasis — muted text between hairlines, the same
   vocabulary the transcript's separators use — with ≥24px hairlines so
   the text can't swallow them. The column (peek or session) supplies the
   horizontal insets, so the note carries none. `className` merges into the
   unavailable box. */
export function TranscriptNoteRow({
  note,
  className,
}: {
  note: TranscriptNote;
  className?: string;
}) {
  if (note.kind === "trimmed") {
    return (
      <div
        data-transcript-note
        data-kind="trimmed"
        className="flex items-center gap-3 text-[12.5px] text-muted-foreground/70"
      >
        <span className="h-px min-w-6 flex-1 bg-[var(--v3-line)]" />
        <span className="min-w-0 shrink text-center">{note.text}</span>
        <span className="h-px min-w-6 flex-1 bg-[var(--v3-line)]" />
      </div>
    );
  }
  return (
    <div
      data-transcript-note
      data-kind="unavailable"
      className={cn(
        "rounded-[10px] border border-[var(--v3-line)] border-dashed px-4 py-3 text-[13.5px] text-muted-foreground",
        className,
      )}
    >
      {note.text}
    </div>
  );
}
