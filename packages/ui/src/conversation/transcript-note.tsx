import type { TranscriptNote } from "../types";

/* #532: one note visual per kind, shared so Focus and ThreadView can't
   drift. The VIEW picks the position — "trimmed" heads the transcript (it
   describes history missing above the first entry), "unavailable" keeps
   the dashed tail box (#28 is about the live tail). The divider mirrors
   the "N replies" separator: hairline — centered muted text — hairline,
   with ≥24px guaranteed hairlines so the text can't swallow them. */
export function TranscriptNoteRow({ note }: { note: TranscriptNote }) {
  if (note.kind === "trimmed") {
    return (
      <div
        data-transcript-note
        data-kind="trimmed"
        className="my-2 flex items-center gap-2 px-3 text-muted-foreground text-xs sm:px-5"
      >
        <span className="h-px min-w-6 flex-1 bg-border" />
        <span className="min-w-0 shrink text-center">{note.text}</span>
        <span className="h-px min-w-6 flex-1 bg-border" />
      </div>
    );
  }
  return (
    <div
      data-transcript-note
      data-kind="unavailable"
      className="mx-3 my-2 rounded-lg border border-dashed px-3 py-2 text-muted-foreground text-xs sm:mx-5"
    >
      {note.text}
    </div>
  );
}
