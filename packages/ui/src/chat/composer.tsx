import type { ChatStatus } from "ai";
import { PaperclipIcon, SquareIcon } from "lucide-react";
import { useState } from "react";
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

/* Send button: enabled when there's text OR at least one attachment chip. */
function SendButton({
  hasDraft,
  status,
}: {
  hasDraft: boolean;
  status?: ChatStatus;
}) {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputSubmit
      disabled={!hasDraft && attachments.files.length === 0}
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
  tools,
  queued,
  accept,
}: {
  placeholder: string;
  employees: Employee[];
  hint: string;
  onSend?: (text: string, files?: AttachedFile[]) => void;
  status?: ChatStatus;
  onStop?: () => void;
  tools?: React.ReactNode;
  queued?: React.ReactNode;
  /* What the host accepts as attachments (e.g. "image/*"). Without it the paperclip
     and chips don't render — the control needs its enabling prop. */
  accept?: string;
}) {
  const [draft, setDraft] = useState("");
  const mentionOpen = employees.length > 0 && /@\w*$/.test(draft);
  const busy = status === "submitted" || status === "streaming";
  return (
    <div className="relative m-2 mt-1 shrink-0 sm:m-3 sm:mt-2">
      {queued}
      {mentionOpen && (
        <div className="absolute bottom-full left-2 z-10 mb-2 w-80 max-w-[calc(100%-1rem)] rounded-lg border bg-popover p-1 shadow-lg">
          {employees.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => setDraft(draft.replace(/@\w*$/, `@${e.name} `))}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
            >
              <HermesAvatar status={e.status} className="size-5" />
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
        onSubmit={({ text, files }) => {
          const t = text.trim() || draft.trim();
          if (!t && files.length === 0) return;
          onSend?.(
            t,
            files.map((f) => ({
              name: f.filename ?? "attachment",
              mediaType: f.mediaType ?? "",
            })),
          );
          setDraft("");
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
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            className="min-h-12"
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools className="min-w-0">
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
              aria-label="Stop"
            >
              <SquareIcon className="size-3.5 fill-current" />
            </PromptInputSubmit>
          ) : (
            <SendButton
              hasDraft={!!draft.trim()}
              status={busy ? undefined : status}
            />
          )}
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
