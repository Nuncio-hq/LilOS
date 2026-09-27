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
import type {
  AttachedFile,
  ModelChoice,
  ModelOption,
  ModelPickerExtras,
} from "../types";
import { choiceFor, ModelPicker } from "./model-picker";

/* Same attach UX as the main composer: the paperclip opens PromptInput's file dialog. */
function FocusAttachButton() {
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

export function FocusComposer({
  running,
  status,
  placeholder,
  hint,
  choice,
  models,
  onModel,
  picker,
  onSend,
  onStop,
  accept,
  maxFileSize,
  onAttachError,
}: {
  running: boolean;
  status: ChatStatus;
  placeholder: string;
  hint: string;
  /* The session's pick; defaults to the first model. */
  choice?: ModelChoice;
  models?: ModelOption[];
  /* No onModel → no model picker: the control needs its handler (issue #19). */
  onModel?: (c: ModelChoice) => void;
  /* Refresh / Edit models… / provider names — each renders only with its handler. */
  picker?: ModelPickerExtras;
  onSend: (t: string, files?: AttachedFile[]) => void;
  onStop?: () => void;
  /* Same contract as Composer: no accept, no attach control. */
  accept?: string;
  /* Attachment byte cap before send (#31) — the relay stays authoritative. */
  maxFileSize?: number;
  /* Rejected attachments surface through this; without it the error is silent. */
  onAttachError?: (message: string) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    // While the employee works, Enter steers the turn (session.steer — the default and only behavior;
    // the running-state placeholder/hint come from the shared runningComposer in agent-chat.tsx).
    <div>
      <PromptInput
        accept={accept}
        multiple
        maxFileSize={maxFileSize}
        onError={
          onAttachError ? (err) => onAttachError(err.message) : undefined
        }
        onSubmit={({ text, files }) => {
          const t = text.trim() || draft.trim();
          if (!t && files.length === 0) return;
          onSend(
            t,
            files.map((f) => ({
              name: f.filename ?? "attachment",
              mediaType: f.mediaType ?? "",
              url: f.url,
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
            className="min-h-14"
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools className="min-w-0">
            {accept && <FocusAttachButton />}
            {onModel && models?.length ? (
              <ModelPicker
                value={choice ?? choiceFor(models[0].id, models)}
                models={models}
                onChoice={onModel}
                {...picker}
              />
            ) : null}
            <span className="hidden truncate text-muted-foreground text-xs md:inline">
              {hint}
            </span>
          </PromptInputTools>
          <div className="flex shrink-0 items-center gap-1">
            {running && !draft.trim() && onStop ? (
              <PromptInputSubmit
                status={status}
                type="button"
                onClick={onStop}
                aria-label="Stop"
              >
                <SquareIcon className="size-3.5 fill-current" />
              </PromptInputSubmit>
            ) : (
              <PromptInputSubmit disabled={!draft.trim()} />
            )}
          </div>
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
