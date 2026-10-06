import { useControllableState } from "@radix-ui/react-use-controllable-state";
import type { ChatStatus } from "ai";
import { FileIcon, FolderIcon, PaperclipIcon, SquareIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  PromptInput,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "../components/ai-elements/prompt-input";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import type { AttachedFile, Employee, FileMention } from "../types";
import { composerKeyDown } from "./composer-keys";
import {
  insertMention,
  mentionBeforeCaret,
  mentionQuery,
} from "./composer-mentions";

/* The paperclip opens the file dialog through PromptInput's attachments context. */
function AttachButton() {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputButton
      onClick={attachments.openFileDialog}
      aria-label="Attach files"
      className="text-foreground/70"
    >
      <PaperclipIcon />
    </PromptInputButton>
  );
}

/* Send button: enabled when there's text OR at least one attachment chip,
   and only while no send is in flight. */
function SendButton({
  hasDraft,
  status,
  sending,
}: {
  hasDraft: boolean;
  status?: ChatStatus;
  sending: boolean;
}) {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputSubmit
      disabled={sending || (!hasDraft && attachments.files.length === 0)}
      status={status}
    />
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

export function Composer({
  placeholder,
  employees,
  hint,
  onSend,
  status = "ready",
  onStop,
  lastSent,
  tools,
  queued,
  accept,
  maxFileSize,
  maxFiles,
  onAttachError,
  onSearchFiles,
  draft: draftProp,
  onDraftChange,
  seedFiles,
  onSeededFiles,
}: {
  placeholder: string;
  employees: Employee[];
  hint: string;
  /* Return a promise to delay clearing: a rejected send keeps the text (#103). */
  onSend?: (text: string, files?: AttachedFile[]) => void | Promise<unknown>;
  status?: ChatStatus;
  onStop?: () => void;
  /* ↑ in an empty composer recalls this — the last message you sent here
     (issue #104). Computed by the host; absent = ↑ stays a caret move. */
  lastSent?: string;
  tools?: React.ReactNode;
  queued?: React.ReactNode;
  /* File search for the `@` menu's Files section (#105): called with the text
     typed after `@`, returns matching files/dirs of the session's folder.
     Absent → no Files section (D-#19: no folder context, no control). */
  onSearchFiles?: (query: string) => Promise<FileMention[]>;
  /* What the host accepts as attachments (e.g. "image/*"). Without it the paperclip
     and chips don't render — the control needs its enabling prop. */
  accept?: string;
  /* Attachment byte cap enforced before send (#31); the relay's own cap is the
     authoritative copy — this one just fails fast. */
  maxFileSize?: number;
  /* How many attachments a send may carry (relay's per-message cap). */
  maxFiles?: number;
  /* Rejected attachment surfaced to the host (e.g. oversize) — no handler, no
     error surface: the toast is the app's job (D-#19). */
  onAttachError?: (message: string) => void;
  /* Host-held draft (issue #103): pass both to control the text — the host
     stores it per conversation; omitted, the composer keeps its own state. */
  draft?: string;
  onDraftChange?: (v: string) => void;
  /* Rewind prefill (issue #134 AC-4): message attachments (data-URL or blob
     URL `url`s) re-enter as real chips once — the host clears the prop via
     `onSeededFiles` so a reseed on the same composer works again. */
  seedFiles?: AttachedFile[];
  onSeededFiles?: () => void;
}) {
  const [draft, setDraft] = useControllableState({
    prop: draftProp,
    onChange: onDraftChange,
    defaultProp: "",
  });
  /* Latest draft for the async-send clear below — reading the ref at resolve
     time means typing during a slow send survives (it's a new draft). */
  const draftRef = useRef(draft);
  draftRef.current = draft;
  /* Esc closes the `@` menu once; the next keystroke reopens it (the menu is
     derived from the draft, so dismissal lives in a flag). */
  const [mentionDismissed, setMentionDismissed] = useState(false);
  /* A promise-returning onSend keeps the submit in flight until it settles
     (#130): `sendRef` dedupes submits that arrive while one is pending, and
     `sending` disables the send button so Enter-Enter can't reach
     requestSubmit at all. */
  const [sending, setSending] = useState(false);
  const sendRef = useRef<Promise<void> | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  /* File rows for the Files section: the host fuzzy-matches per keystroke;
     `null` = a search is in flight, `[]` = no hits. */
  const fragment = mentionQuery(draft);
  const fragmentQuery = fragment?.query ?? null;
  const [fileHits, setFileHits] = useState<FileMention[] | null>(null);
  const searchSeq = useRef(0);
  useEffect(() => {
    if (!onSearchFiles || fragmentQuery === null) {
      setFileHits(null);
      return;
    }
    const seq = ++searchSeq.current;
    let live = true;
    void onSearchFiles(fragmentQuery).then(
      (hits) => {
        if (live && seq === searchSeq.current) setFileHits(hits);
      },
      () => {
        if (live && seq === searchSeq.current) setFileHits([]);
      },
    );
    return () => {
      live = false;
    };
  }, [onSearchFiles, fragmentQuery]);
  /* Flat keyboard navigation across both sections (issue #105, AC-1): one
     active index over [employees…, files…]; ↓/↑ move, Enter picks, Esc stays
     the existing dismiss path. */
  const [active, setActive] = useState(0);
  useEffect(() => {
    setActive(0);
  }, [fragmentQuery, fileHits]);
  type Row =
    | { kind: "emp"; employee: Employee }
    | { kind: "file"; file: FileMention };
  const rows: Row[] = [
    ...employees.map((e) => ({ kind: "emp" as const, employee: e })),
    ...(fileHits ?? []).map((f) => ({ kind: "file" as const, file: f })),
  ];
  const mentionOpen =
    !mentionDismissed &&
    fragment !== null &&
    (employees.length > 0 || !!onSearchFiles);
  /* Caret moves a pick/delete wants, applied in the layout effect right after
     the draft commits — an rAF can fire after the next keystroke and yank the
     caret backwards mid-typing (e2e caught `@src/app.tsx ap@`). */
  const caretRef = useRef<number | null>(null);
  const prevDraftRef = useRef(draft);
  useLayoutEffect(() => {
    /* #590 AC-1: an external prefill (draft goes empty → text — plan
       "Change…", a seeded rewind) focuses the composer and lands the caret
       at the end, after any prefix, so the user types the answer straight
       away. Pick/deletes take precedence via caretRef. */
    const at =
      caretRef.current ??
      (prevDraftRef.current === "" && draft !== "" ? draft.length : null);
    caretRef.current = null;
    prevDraftRef.current = draft;
    if (at === null) return;
    const el = wrapRef.current?.querySelector("textarea");
    el?.focus();
    el?.setSelectionRange(at, at);
  });
  const pickMention = (row: Row) => {
    const next =
      row.kind === "emp"
        ? insertMention(draft, row.employee.name, false)
        : insertMention(draft, row.file.path, row.file.kind === "dir");
    caretRef.current = next.length;
    setDraft(next);
  };
  const busy = status === "submitted" || status === "streaming";
  return (
    /* data-composer marks the bottom-anchored block the app's toast clears
       (queued chips included — they're inside this wrapper). */
    <div
      ref={wrapRef}
      data-composer
      className="relative m-2 mt-1 shrink-0 sm:m-3 sm:mt-2"
    >
      {queued}
      {mentionOpen && (
        <div
          role="listbox"
          aria-label="Mention"
          className="absolute bottom-full left-2 z-10 mb-2 max-h-64 w-80 max-w-[calc(100%-1rem)] overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg"
        >
          {employees.length > 0 && (
            <div data-mention-section="employees" role="presentation">
              <div className="px-2 pt-1 pb-0.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
                Employees
              </div>
              {employees.map((e, i) => (
                <button
                  key={e.id}
                  type="button"
                  role="option"
                  aria-selected={active === i}
                  onClick={() => pickMention({ kind: "emp", employee: e })}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
                    active === i ? "bg-muted" : "hover:bg-muted",
                  )}
                >
                  <HermesAvatar
                    name={e.name}
                    status={e.status}
                    className="size-5"
                  />
                  <span className="font-medium">{e.name}</span>
                  <span className="ml-auto text-muted-foreground text-xs">
                    {e.role} · new session
                  </span>
                </button>
              ))}
            </div>
          )}
          {onSearchFiles && (
            <div data-mention-section="files" role="presentation">
              <div className="px-2 pt-1 pb-0.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
                Files
              </div>
              {fileHits === null ? (
                <div className="px-2 py-1.5 text-muted-foreground text-xs">
                  Searching…
                </div>
              ) : fileHits.length === 0 ? (
                <div className="px-2 py-1.5 text-muted-foreground text-xs">
                  No matches
                </div>
              ) : (
                fileHits.map((f, j) => {
                  const i = employees.length + j;
                  return (
                    <button
                      key={f.path}
                      type="button"
                      role="option"
                      aria-selected={active === i}
                      data-mention-file={f.path}
                      data-kind={f.kind}
                      onClick={() => pickMention({ kind: "file", file: f })}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
                        active === i ? "bg-muted" : "hover:bg-muted",
                      )}
                    >
                      {f.kind === "dir" ? (
                        <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate font-mono text-xs">
                        {f.path}
                        {f.kind === "dir" ? "/" : ""}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>
      )}
      {/* AI Elements prompt-input owns attach UX: pick (hidden input + paperclip), drop on
          the form, paste into the textarea, Backspace-on-empty removes the last chip. */}
      <PromptInput
        accept={accept}
        multiple
        maxFileSize={maxFileSize}
        maxFiles={maxFiles}
        onError={
          onAttachError ? (err) => onAttachError(err.message) : undefined
        }
        onSubmit={({ text, files }) => {
          /* A send already in flight owns the outcome: a second submit (Enter
             pressed twice, a requestSubmit) joins the pending promise instead
             of sending the same draft again (#130 AC-3). */
          if (sendRef.current) return sendRef.current;
          const t = text.trim() || draft.trim();
          if (!t && files.length === 0) return;
          const done = onSend?.(
            t,
            files.map((f) => ({
              name: f.filename ?? "attachment",
              mediaType: f.mediaType ?? "",
              url: f.url,
            })),
          );
          /* Clear only when the box still holds what was sent — text typed
             while an async send is in flight is a new draft, not part of the
             sent message (#103 AC-5). A rejected send keeps everything. */
          const clearIfUnchanged = () => {
            if (draftRef.current.trim() === t) setDraft("");
          };
          if (done && typeof done.then === "function") {
            setSending(true);
            const send = done.then(clearIfUnchanged).finally(() => {
              sendRef.current = null;
              setSending(false);
            });
            sendRef.current = send;
            return send;
          }
          clearIfUnchanged();
        }}
      >
        {seedFiles?.length && onSeededFiles ? (
          <FileSeeder seed={seedFiles} onSeeded={onSeededFiles} />
        ) : null}
        {accept && (
          <PromptInputAttachments className="px-3 pt-3 pb-0">
            {(file) => <PromptInputAttachment data={file} />}
          </PromptInputAttachments>
        )}
        <PromptInputBody>
          <PromptInputTextarea
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setMentionDismissed(false);
            }}
            onKeyDown={(e) => {
              if (
                mentionOpen &&
                (e.key === "ArrowDown" ||
                  e.key === "ArrowUp" ||
                  e.key === "Enter" ||
                  e.key === "Tab")
              ) {
                /* The open menu owns these keys (AC-1): ↑/↓ move the flat
                   highlight, Enter/Tab insert the highlighted row. */
                e.preventDefault();
                if (rows.length === 0) return;
                if (e.key === "ArrowDown") {
                  setActive((a) => (a + 1) % rows.length);
                } else if (e.key === "ArrowUp") {
                  setActive((a) => (a - 1 + rows.length) % rows.length);
                } else {
                  pickMention(rows[Math.min(active, rows.length - 1)]);
                }
                return;
              }
              /* Atomic chips (#105, AC-3): Backspace right after an `@token`
                 removes the whole mention, not one character. */
              if (e.key === "Backspace" && !e.defaultPrevented) {
                const el = e.currentTarget;
                if (el.selectionStart === el.selectionEnd) {
                  const at = mentionBeforeCaret(el.value, el.selectionStart);
                  if (at !== null) {
                    e.preventDefault();
                    caretRef.current = at;
                    setDraft(
                      el.value.slice(0, at) + el.value.slice(el.selectionStart),
                    );
                    return;
                  }
                }
              }
              composerKeyDown({
                running: busy,
                onStop,
                lastSent,
                setDraft,
                onDismissOverlay: mentionOpen
                  ? () => setMentionDismissed(true)
                  : undefined,
              })(e);
            }}
            placeholder={placeholder}
            className="min-h-12"
          />
        </PromptInputBody>
        <PromptInputFooter>
          {/* #590 AC-2: one row of controls at 1024px — no wrap; the hint
              truncates away before a control ever drops to a second line. */}
          <PromptInputTools className="min-w-0 overflow-hidden">
            {accept && <AttachButton />}
            {tools}
            <span className="lilos-hint hidden truncate text-muted-foreground text-xs sm:inline">
              {hint}
            </span>
          </PromptInputTools>
          {busy && !draft.trim() && onStop ? (
            <PromptInputSubmit
              status={status}
              type="button"
              onClick={onStop}
              title="Stop (⌘.)"
              aria-label="Stop (⌘.)"
            >
              <SquareIcon className="size-3.5 fill-current" />
            </PromptInputSubmit>
          ) : (
            <SendButton
              hasDraft={!!draft.trim()}
              status={busy ? undefined : status}
              sending={sending}
            />
          )}
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
