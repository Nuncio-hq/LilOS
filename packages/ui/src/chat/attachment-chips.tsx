import {
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
} from "lucide-react";
import type { AttachedFile } from "../types";

/* Files sent with a message, shown as chips under the body — the same shape the composer
   shows before send, so an attached image reads the same in both places. Image files
   with a `url` (a data URL while bytes ride with the message) show a thumbnail; other
   files get a type icon, their name and their size. */

const ICONS = {
  text: FileTextIcon,
  code: FileCodeIcon,
  sheet: FileSpreadsheetIcon,
  image: FileImageIcon,
  audio: FileAudioIcon,
  video: FileVideoIcon,
  archive: FileArchiveIcon,
  other: FileIcon,
};

function iconFor(mediaType: string) {
  const mime = mediaType.toLowerCase();
  if (mime.startsWith("image/")) return ICONS.image;
  if (mime.startsWith("audio/")) return ICONS.audio;
  if (mime.startsWith("video/")) return ICONS.video;
  if (/zip|tar|gzip|7z|rar|archive|compressed/.test(mime))
    return ICONS.archive;
  if (
    /json|javascript|typescript|xml|yaml|x-sh|sql|graphql|wasm/.test(mime)
  )
    return ICONS.code;
  if (/csv|excel|spreadsheet/.test(mime)) return ICONS.sheet;
  if (mime.startsWith("text/") || /pdf|document|msword|rtf/.test(mime))
    return ICONS.text;
  return ICONS.other;
}

function formatBytes(bytes: number): string {
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

export function AttachmentChips({ files }: { files: AttachedFile[] }) {
  if (!files.length) return null;
  return (
    <div data-attachments className="flex flex-wrap gap-1.5 pt-1">
      {files.map((f, i) => {
        const Icon = iconFor(f.mediaType);
        return (
          <span
            key={i}
            className="inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs"
            title={f.mediaType}
          >
            {f.url && f.mediaType.startsWith("image/") ? (
              <img
                src={f.url}
                alt={f.name}
                className="size-8 rounded-sm object-cover"
              />
            ) : (
              <Icon className="size-3 text-muted-foreground" />
            )}
            <span className="max-w-48 truncate font-medium">{f.name}</span>
            {typeof f.sizeBytes === "number" && (
              <span className="text-muted-foreground">
                {formatBytes(f.sizeBytes)}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}
