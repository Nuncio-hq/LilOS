import { PaperclipIcon } from "lucide-react";
import type { AttachedFile } from "../types";

/* Files sent with a message, shown as chips under the body — the same shape the composer
   shows before send, so an attached image reads the same in both places. Image files
   with a `url` (a data URL while bytes ride with the message) show a thumbnail. */
export function AttachmentChips({ files }: { files: AttachedFile[] }) {
  if (!files.length) return null;
  return (
    <div data-attachments className="flex flex-wrap gap-1.5 pt-1">
      {files.map((f, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs"
        >
          {f.url && f.mediaType.startsWith("image/") ? (
            <img
              src={f.url}
              alt={f.name}
              className="size-8 rounded-sm object-cover"
            />
          ) : (
            <PaperclipIcon className="size-3 text-muted-foreground" />
          )}
          <span className="max-w-48 truncate font-medium">{f.name}</span>
        </span>
      ))}
    </div>
  );
}
