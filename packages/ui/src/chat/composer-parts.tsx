import { PaperclipIcon, SquareIcon } from "lucide-react";
import { useEffect } from "react";
import {
  PromptInputButton,
  usePromptInputAttachments,
} from "../components/ai-elements/prompt-input";
import { cn } from "../lib/utils";
import type { AttachedFile } from "../types";

/* The pieces of the v3 message box both chat composers (the thread's and the
   session view's) draw the same way: the paperclip, the ⌘↵ key hint, the
   Send/Queue pill and the Stop pill, plus the rewind image re-seeder. */

/* The paperclip opens the file dialog through PromptInput's attachments context. */
export function AttachButton() {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputButton
      onClick={attachments.openFileDialog}
      aria-label="Attach files"
      title="Attach files"
      size="icon-xs"
      className="mr-0.5 text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground"
    >
      <PaperclipIcon className="size-3.5" />
    </PromptInputButton>
  );
}

export function ComposerKbd({ className }: { className?: string }) {
  return (
    <kbd
      className={cn(
        "shrink-0 rounded border border-[var(--v3-line)] bg-background px-1.5 font-sans text-[11px] text-muted-foreground",
        className,
      )}
    >
      ⌘↵
    </kbd>
  );
}

const PILL =
  "ml-1 inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-[7px] border px-2.5 font-medium text-[13px] outline-none transition-[background,transform] focus-visible:ring-2 focus-visible:ring-foreground/30 enabled:active:scale-[0.97]";

/* Send — "Queue" while a turn runs, since the message then waits for it.
   Enabled when there's text OR at least one attachment chip, and only while
   no send is in flight. */
export function SendPill({
  hasDraft,
  working,
  sending,
}: {
  hasDraft: boolean;
  working: boolean;
  sending: boolean;
}) {
  const attachments = usePromptInputAttachments();
  const sendable = !sending && (hasDraft || attachments.files.length > 0);
  return (
    <button
      type="submit"
      disabled={!sendable}
      className={cn(
        PILL,
        sendable
          ? "border-foreground bg-foreground text-background hover:bg-foreground/85"
          : "border-[var(--v3-line)] text-muted-foreground/60",
      )}
    >
      {working ? "Queue" : "Send"}
    </button>
  );
}

/* Stop replaces Send while a turn runs and the box is empty. */
export function StopPill({ onStop }: { onStop: () => void }) {
  return (
    <button
      type="button"
      onClick={onStop}
      title="Stop (⌘.)"
      aria-label="Stop (⌘.)"
      className={cn(
        PILL,
        "border-[var(--v3-line)] text-foreground hover:bg-[var(--v3-hover)]",
      )}
    >
      <SquareIcon className="size-3 fill-current" />
      Stop
    </button>
  );
}

/* Rewind prefill (issue #134 AC-4): a user message's stored images come
   back as real attachment chips — fetched bytes turned back into Files so a
   resend ships them again untouched. */
export function FileSeeder({
  seed,
  onSeeded,
}: {
  seed: AttachedFile[];
  onSeeded: () => void;
}) {
  const attachments = usePromptInputAttachments();
  useEffect(() => {
    /* No "already seeded" ref guard: StrictMode's mount→cleanup→mount
       leaves the first fetch cancelled and the ref set, so the real seed
       never lands. The second effect's fetch is what must complete. */
    let cancelled = false;
    void Promise.all(
      seed.map(async (f) => {
        if (!f.url) return null;
        const blob = await fetch(f.url).then((r) => r.blob());
        return new File([blob], f.name, { type: f.mediaType });
      }),
    )
      .then((files) => {
        if (cancelled) return;
        const ok = files.filter((f): f is File => f !== null);
        if (ok.length) attachments.add(ok);
        onSeeded();
      })
      .catch(() => onSeeded());
    return () => {
      cancelled = true;
    };
    // attachments.add is stable; seed identity is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);
  return null;
}
