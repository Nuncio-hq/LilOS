/* What a message may carry, said once: every composer that stages files (the
   chat composer through PromptInput, the v3 new-chat draft) asks these, so a
   file refused in one is refused in the other, in the same words. The caps
   themselves belong to the wire (`MAX_ATTACHMENT_BYTES`,
   `MAX_ATTACHMENTS_PER_MESSAGE`); the app hands them in. */

/** `1.2 MB`-style label for a chip or a refusal line. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let size = bytes;
  let unit = "B";
  for (const u of units) {
    if (size < 1024) break;
    size /= 1024;
    unit = u;
  }
  return `${size >= 100 ? Math.round(size) : size.toFixed(1)} ${unit}`;
}

/** The files within the per-file byte cap, and a plain line when some (or
    all) were over it: a lost attachment is never silent. */
export function withinSize<T extends { size: number }>(
  files: T[],
  maxFileSize?: number,
): { kept: T[]; note?: string } {
  if (!maxFileSize) return { kept: files };
  const kept = files.filter((f) => f.size <= maxFileSize);
  if (files.length > 0 && kept.length === 0)
    return {
      kept,
      note: `That file is too large to attach (${formatBytes(maxFileSize)} max per file).`,
    };
  if (kept.length < files.length)
    return {
      kept,
      note: `Some files were too large to attach (${formatBytes(maxFileSize)} max per file) and were left out.`,
    };
  return { kept };
}

/** As many of `files` as still fit beside the `staged` ones under the
    per-message cap, and a plain line when some were left out. */
export function withinCount<T>(
  files: T[],
  staged: number,
  maxFiles?: number,
): { kept: T[]; note?: string } {
  if (typeof maxFiles !== "number") return { kept: files };
  const room = Math.max(0, maxFiles - staged);
  if (files.length <= room) return { kept: files };
  return {
    kept: files.slice(0, room),
    note: "Too many files. Some were not added.",
  };
}
