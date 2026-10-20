import { FileIcon, PaperclipIcon, XIcon } from "lucide-react";
import {
  type ClipboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { formatBytes, withinCount, withinSize } from "../lib/attach-rules";
import type { AttachedFile } from "../types";
import type { V3Data } from "./v3-types";

/* Files staged in a v3 message box before the first send: paste, drop or the
   paperclip put them here as chips you can remove. The caps come from the app
   (`data.attachLimits`, the wire's own), the checks from `lib/attach-rules`
   (the same ones the chat composer's PromptInput runs), so a file is refused
   here exactly when it is refused there. Any file type goes. */

export type Staged = {
  id: number;
  file: File;
  /** An image's own picture for the chip; revoked when the chip goes. */
  preview?: string;
};

export type Attach = {
  files: Staged[];
  /** Why something was left out or not sent; goes with the next change, or
      after a few seconds. */
  note?: string;
  add: (files: File[]) => void;
  remove: (id: number) => void;
  clear: () => void;
  warn: (text: string) => void;
};

const NOTE_MS = 5000;

/** The staged files and their rules; undefined where the app sends no files. */
export function useAttach(limits: V3Data["attachLimits"]): Attach | undefined {
  const [files, setFiles] = useState<Staged[]>([]);
  const [note, setNote] = useState<string>();
  // Two adds in one tick (a drop, then a paste) must see each other.
  const live = useRef(files);
  const nextId = useRef(1);
  const maxBytes = limits?.maxFileBytes;
  const maxFiles = limits?.maxFiles;

  const set = useCallback((list: Staged[]) => {
    live.current = list;
    setFiles(list);
  }, []);

  const add = useCallback(
    (incoming: File[]) => {
      if (maxBytes === undefined || incoming.length === 0) return;
      const sized = withinSize(incoming, maxBytes);
      const room = withinCount(sized.kept, live.current.length, maxFiles);
      setNote(room.note ?? sized.note);
      if (room.kept.length === 0) return;
      set([
        ...live.current,
        ...room.kept.map((file) => ({
          id: nextId.current++,
          file,
          preview: file.type.startsWith("image/")
            ? URL.createObjectURL(file)
            : undefined,
        })),
      ]);
    },
    [maxBytes, maxFiles, set],
  );

  const remove = useCallback(
    (id: number) => {
      const gone = live.current.find((s) => s.id === id);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      set(live.current.filter((s) => s.id !== id));
      setNote(undefined);
    },
    [set],
  );

  const clear = useCallback(() => {
    for (const s of live.current) if (s.preview) URL.revokeObjectURL(s.preview);
    set([]);
    setNote(undefined);
  }, [set]);

  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(undefined), NOTE_MS);
    return () => window.clearTimeout(t);
  }, [note]);

  useEffect(
    () => () => {
      for (const s of live.current)
        if (s.preview) URL.revokeObjectURL(s.preview);
    },
    [],
  );

  if (maxBytes === undefined) return undefined;
  return { files, note, add, remove, clear, warn: setNote };
}

/** The staged files as the app sends them: the bytes inlined as data URLs,
    like the chat composer's. Rejects when a file cannot be read. */
export function readStaged(files: Staged[]): Promise<AttachedFile[]> {
  return Promise.all(
    files.map(
      ({ file }) =>
        new Promise<AttachedFile>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () =>
            resolve({
              name: file.name || "attachment",
              mediaType: file.type,
              url: String(r.result),
              sizeBytes: file.size,
            });
          r.onerror = () => reject(r.error);
          r.readAsDataURL(file);
        }),
    ),
  );
}

/** Files on the clipboard, if any (an image copied from anywhere). */
export function pastedFiles(e: ClipboardEvent): File[] {
  const out: File[] = [];
  for (const item of e.clipboardData?.items ?? []) {
    const file = item.kind === "file" ? item.getAsFile() : null;
    if (file) out.push(file);
  }
  return out;
}

/** The paperclip, with the file input it opens. */
export function AttachButton({ attach }: { attach: Attach }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept="*/*"
        aria-label="Upload files"
        className="hidden"
        onChange={(e) => {
          attach.add([...(e.currentTarget.files ?? [])]);
          // The same file can be chosen again after its chip was removed.
          e.currentTarget.value = "";
        }}
      />
      <button
        type="button"
        aria-label="Attach files"
        title="Attach files"
        onClick={() => input.current?.click()}
        className="mr-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground"
      >
        <PaperclipIcon className="size-3.5" />
      </button>
    </>
  );
}

/** The staged files above the text, each with a way to take it back out,
    and the line that says what was left out. */
export function AttachChips({ attach }: { attach: Attach }) {
  if (attach.files.length === 0 && !attach.note) return null;
  return (
    <div data-staged className="flex flex-wrap items-center gap-1.5 pb-2">
      {attach.files.map((s) => (
        <span
          key={s.id}
          title={s.file.type || undefined}
          className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-[var(--v3-line)] pr-0.5 pl-1.5 text-[12.5px]"
        >
          {s.preview ? (
            <img
              src={s.preview}
              alt={s.file.name}
              className="size-5 shrink-0 rounded-sm object-cover"
            />
          ) : (
            <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 max-w-48 truncate">{s.file.name}</span>
          <span className="shrink-0 text-muted-foreground">
            {formatBytes(s.file.size)}
          </span>
          <button
            type="button"
            aria-label={`Remove ${s.file.name}`}
            onClick={() => attach.remove(s.id)}
            className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground"
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
      {attach.note && (
        <span role="status" className="text-[12.5px] text-muted-foreground">
          {attach.note}
        </span>
      )}
    </div>
  );
}
