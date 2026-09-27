import { useControllableState } from "@radix-ui/react-use-controllable-state";
import type { ChatStatus } from "ai";
import { PaperclipIcon, SquareIcon } from "lucide-react";
import { useRef, useState } from "react";
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
import { HermesAvatar } from "../shell/avatars";
import type { AttachedFile, Employee } from "../types";
import { composerKeyDown } from "./composer-keys";

/* The paperclip opens the file dialog through PromptInput's attachments context. */
function AttachButton() {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputButton
      onClick={attachments.openFileDialog}
      aria-label="Attach files"
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
  draft: draftProp,
  onDraftChange,
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
  const mentionOpen =
    employees.length > 0 && !mentionDismissed && /@\w*$/.test(draft);
  const busy = status === "submitted" || status === "streaming";
  return (
    <div className="relative m-2 mt-1 shrink-0 sm:m-3 sm:mt-2">
      {queued}
      {mentionOpen && (
        <div
          role="listbox"
          aria-label="Mention an employee"
          className="absolute bottom-full left-2 z-10 mb-2 w-80 max-w-[calc(100%-1rem)] rounded-lg border bg-popover p-1 shadow-lg"
        >
          {employees.map((e) => (
            <button
              key={e.id}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => setDraft(draft.replace(/@\w*$/, `@${e.name} `))}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
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
            onKeyDown={composerKeyDown({
              running: busy,
              onStop,
              lastSent,
              setDraft,
              onDismissOverlay: mentionOpen
                ? () => setMentionDismissed(true)
                : undefined,
            })}
            placeholder={placeholder}
            className="min-h-12"
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools className="min-w-0 flex-wrap">
            {accept && <AttachButton />}
            {tools}
            <span className="hidden truncate text-muted-foreground text-xs sm:inline">
              {hint}
            </span>
          </PromptInputTools>
          {busy && !draft.trim() && onStop ? (
            <PromptInputSubmit
              status={status}
              type="button"
              onClick={onStop}
              title="Stop (Esc)"
              aria-label="Stop (Esc)"
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
