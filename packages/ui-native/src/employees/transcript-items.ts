import type { ThreadDetail, ThreadEntry } from "./types";

/* #514: a transcript's state note (web: transcriptNote). The trimmed note
   describes history missing ABOVE the first visible message, so it renders
   as the first scroll item — a centered low-emphasis divider — before the
   entries, not after them. `transcriptItems` keeps that order in one place
   the screen and the test both use (#431 historyTrimmed). */
export type TranscriptNoteItem = {
  kind: "transcript-note";
  id: string;
  text: string;
};

export type TranscriptItem = TranscriptNoteItem | ThreadEntry;

export function transcriptItems(
  detail: Pick<ThreadDetail, "entries" | "transcriptNote">,
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  if (detail.transcriptNote) {
    items.push({
      kind: "transcript-note",
      id: "transcript-note",
      text: detail.transcriptNote,
    });
  }
  for (const e of detail.entries) items.push(e);
  return items;
}
