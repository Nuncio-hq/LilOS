import {
  CheckIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import { useUiLayer } from "../chat/ui-layers";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import type { DiffComment } from "../types";
import { anchorFor, type DiffRow } from "./diff-rows";
import { WbBtn } from "./wb-bits";

/* The two table rows a review comment takes under a diff line: the editor
   it is written in, and the note it becomes. */

export function CommentEditor({
  rows,
  lo,
  hi,
  initial,
  onSubmit,
  onClose,
}: {
  rows: DiffRow[];
  lo: number;
  hi: number;
  /** The comment being edited — its own span labels the editor. */
  initial?: DiffComment;
  onSubmit: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial?.text ?? "");
  /* Esc must close only this editor, not the Focus/panel layer beneath —
     register on the layer stack so dispatch stops here (#576). The
     textarea's own Esc → onClose stays as a harmless duplicate. */
  useUiLayer({ onEscape: onClose });
  const a = initial ?? anchorFor(rows, lo, hi);
  const range =
    a.start === a.end ? `line ${a.start}` : `lines ${a.start}–${a.end}`;
  return (
    <tr data-comment-editor>
      <td
        colSpan={3}
        className="border-[var(--v3-line)] border-t bg-background p-0 font-sans"
      >
        <div className="border-l-2 border-l-amber-500 bg-amber-500/[0.06] px-3 py-2">
          <div className="mb-1 text-[11px] text-muted-foreground">
            Comment on {range}
          </div>
          <Textarea
            autoFocus
            data-comment-input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                text.trim() && onSubmit(text.trim());
            }}
            placeholder="Ask or note something about this code…"
            className="min-h-14 rounded-[7px] border bg-background text-xs"
          />
          <div className="mt-1.5 flex items-center gap-1.5">
            <WbBtn
              primary
              data-comment-save
              disabled={!text.trim()}
              onClick={() => onSubmit(text.trim())}
            >
              {initial ? "Save" : "Comment"}
            </WbBtn>
            <WbBtn className="border-transparent" onClick={onClose}>
              Cancel
            </WbBtn>
            <span className="ml-auto text-[10px] text-muted-foreground/70">
              ⌘⏎ sends · Esc cancels
            </span>
          </div>
        </div>
      </td>
    </tr>
  );
}

/** A comment under its line: pending (amber, with Edit and Delete) or sent
    (sky, with how it went). */
export function CommentNote({
  c,
  onEdit,
  onDelete,
}: {
  c: DiffComment;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <tr data-comment={c.id} {...(c.resolved ? { "data-resolved": true } : {})}>
      <td
        colSpan={3}
        className="border-[var(--v3-line)] border-t p-0 font-sans"
      >
        <div
          className={cn(
            "flex items-start gap-2 px-3 py-1.5 text-xs",
            c.resolved
              ? "border-l-2 border-l-sky-500/60 bg-sky-500/[0.05] text-muted-foreground"
              : "border-l-2 border-l-amber-500 bg-amber-500/[0.06]",
          )}
        >
          {c.resolved ? (
            <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-sky-600" />
          ) : (
            <MessageSquarePlusIcon className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
          )}
          <div className="min-w-0 flex-1">
            {c.resolved && (
              <span
                data-sent-pill
                className="mr-2 rounded-full bg-sky-500/15 px-1.5 py-px font-medium text-[10px] text-sky-700 dark:text-sky-300"
              >
                {c.via === "steer"
                  ? "Sent · steered"
                  : c.via === "queue"
                    ? "Sent · queued"
                    : "Sent"}
              </span>
            )}
            <span className="mr-2 font-mono text-[10px] text-muted-foreground">
              {c.start === c.end
                ? `${c.path}:${c.start}`
                : `${c.path}:${c.start}–${c.end}`}
            </span>
            {c.resolved ? (
              <span className="italic">{c.text}</span>
            ) : (
              <span className="whitespace-pre-wrap">{c.text}</span>
            )}
          </div>
          {!c.resolved && (
            <span className="-mt-1 flex shrink-0 gap-0.5">
              <Button
                variant="ghost"
                size="icon-xs"
                title="Edit comment"
                data-comment-edit
                onClick={onEdit}
              >
                <PencilIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                title="Delete comment"
                data-comment-delete
                onClick={onDelete}
              >
                <Trash2Icon />
              </Button>
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}
