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
import type {
  AttachedFile,
  ModelChoice,
  ModelOption,
  ModelPickerExtras,
} from "../types";
import { FileSeeder } from "./composer";
import { composerKeyDown } from "./composer-keys";
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
  lastSent,
  accept,
  maxFileSize,
  onAttachError,
  draft: draftProp,
  onDraftChange,
  seedFiles,
  onSeededFiles,
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
  /* Return a promise to delay clearing: a rejected send keeps the text (#103). */
  onSend: (t: string, files?: AttachedFile[]) => void | Promise<unknown>;
  onStop?: () => void;
  /* Host-held draft (issue #103): pass both to control the text; omitted, the
     composer keeps its own state. */
  draft?: string;
  onDraftChange?: (v: string) => void;
  /* Same contract as Composer: ↑ in an empty composer recalls it (issue #104). */
  lastSent?: string;
  /* Same contract as Composer: no accept, no attach control. */
  accept?: string;
  /* Attachment byte cap before send (#31) — the relay stays authoritative. */
  maxFileSize?: number;
  /* Rejected attachments surface through this; without it the error is silent. */
  onAttachError?: (message: string) => void;
  /* AC-4 (#134): a rewound message's images re-entering the composer. */
  seedFiles?: AttachedFile[];
  onSeededFiles?: () => void;
}) {
  const [draft, setDraft] = useControllableState({
    prop: draftProp,
    onChange: onDraftChange,
    defaultProp: "",
  });
  /* Latest draft for the async-send clear: text typed while a send is in
     flight is a new draft and survives (#103 AC-5). */
  const draftRef = useRef(draft);
  draftRef.current = draft;
  /* Same in-flight guard as Composer (#130 AC-3): `sendRef` dedupes submits
     while a promise send is pending, `sending` disables the button. */
  const [sending, setSending] = useState(false);
  const sendRef = useRef<Promise<void> | null>(null);
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
          /* A send already in flight owns the outcome: a second submit (Enter
             pressed twice, a requestSubmit) joins the pending promise instead
             of sending the same draft again (#130 AC-3). */
          if (sendRef.current) return sendRef.current;
          const t = text.trim() || draft.trim();
          if (!t && files.length === 0) return;
          const done = onSend(
            t,
            files.map((f) => ({
              name: f.filename ?? "attachment",
              mediaType: f.mediaType ?? "",
              url: f.url,
            })),
          );
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
        {accept && seedFiles?.length && onSeededFiles ? (
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
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={composerKeyDown({
              running,
              onStop,
              lastSent,
              setDraft,
            })}
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
            <span
              className="lilos-hint hidden truncate text-muted-foreground text-xs md:inline"
            >
              {hint}
            </span>
          </PromptInputTools>
          <div className="flex shrink-0 items-center gap-1">
            {running && !draft.trim() && onStop ? (
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
              <PromptInputSubmit disabled={sending || !draft.trim()} />
            )}
          </div>
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
