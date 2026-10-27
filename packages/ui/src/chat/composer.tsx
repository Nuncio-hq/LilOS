import { useControllableState } from "@radix-ui/react-use-controllable-state";
import type { ChatStatus } from "ai";
import { useRef, useState } from "react";
import {
  PromptInput,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputFooter,
  PromptInputTextarea,
  PromptInputTools,
} from "../components/ai-elements/prompt-input";
import { HermesAvatar } from "../shell/avatars";
import type {
  AttachedFile,
  Employee,
  FileMention,
  ModelChoice,
  ModelOption,
  ModelPickerExtras,
  SlashItem,
} from "../types";
import { useComposerMenus } from "./composer-menus";
import {
  AttachButton,
  ComposerKbd,
  FileSeeder,
  SendPill,
  StopPill,
} from "./composer-parts";
import { MentionPopup, SlashPopup } from "./composer-popups";
import { parseSlashDraft } from "./composer-slash";
import { choiceFor, ModelPicker } from "./model-picker";

export function Composer({
  placeholder,
  employees,
  onSend,
  status = "ready",
  onStop,
  lastSent,
  tools,
  choice,
  models,
  onModel,
  picker,
  modelOpen,
  onModelOpen,
  queued,
  accept,
  maxFileSize,
  maxFiles,
  onAttachError,
  onSearchFiles,
  onSearchCommands,
  onCommand,
  draft: draftProp,
  onDraftChange,
  seedFiles,
  onSeededFiles,
  hideStop = false,
}: {
  placeholder: string;
  employees: Employee[];
  /* Return a promise to delay clearing: a rejected send keeps the text (#103). */
  onSend?: (text: string, files?: AttachedFile[]) => void | Promise<unknown>;
  status?: ChatStatus;
  onStop?: () => void;
  /* ↑ in an empty composer recalls this — the last message you sent here
     (issue #104). Computed by the host; absent = ↑ stays a caret move. */
  lastSent?: string;
  /* Extra pills next to the attach button (e.g. #106's AccessPill). */
  tools?: React.ReactNode;
  /* The session's model pick; defaults to the first model. */
  choice?: ModelChoice;
  models?: ModelOption[];
  /* No onModel (or no models) → no model picker: the control needs its
     handler (issue #19). */
  onModel?: (c: ModelChoice) => void;
  /* Refresh / Edit models… / provider names — each renders only with its handler. */
  picker?: ModelPickerExtras;
  /* Controlled open on the model picker — `/model` opens it. */
  modelOpen?: boolean;
  onModelOpen?: (open: boolean) => void;
  queued?: React.ReactNode;
  /* File search for the `@` menu's Files section (#105): called with the text
     typed after `@`, returns matching files/dirs of the session's folder.
     Absent → no Files section (D-#19: no folder context, no control). */
  onSearchFiles?: (query: string) => Promise<FileMention[]>;
  /* Command search for the `/` menu: called with the text typed after the
     leading `/`, returns the engine's commands + skills. Absent → `/` stays
     plain text (D-#19: the engine declares no commands, the menu never
     opens). */
  onSearchCommands?: (query: string) => Promise<SlashItem[]>;
  /* A `/name args` send passes through here first: returning true claims
     it (the app owns that command — the model picker, rewind); false lets
     it post so the engine runs it. */
  onCommand?: (name: string, args: string) => boolean;
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
  /* D-#772: the stuck card owns the visible Stop. The pill hides; ⌘.
     still stops, because `busy` (and `onStop`) stay. */
  hideStop?: boolean;
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
  /* A promise-returning onSend keeps the submit in flight until it settles
     (#130): `sendRef` dedupes submits that arrive while one is pending, and
     `sending` disables the send button so Enter-Enter can't reach
     requestSubmit at all. */
  const [sending, setSending] = useState(false);
  const sendRef = useRef<Promise<void> | null>(null);
  /* The `@` and `/` menus, their keys and the caret after a pick — shared
     with the v3 composer (composer-menus.ts). */
  const menus = useComposerMenus({
    draft,
    setDraft,
    employees,
    onSearchFiles,
    onSearchCommands,
  });
  const busy = status === "submitted" || status === "streaming";
  return (
    /* data-composer marks the bottom-anchored block the app's toast clears
       (queued chips included — they're inside this wrapper). It spans the
       panel; the inner box is the prototype's column — 720px less its 32px
       gutters — so the box lines up with the turns above it. Its 2px
       top margin plus the settled line's 16px overhang is the band under
       the last turn (#602 caps it at 24px; this reads 18). The line stays
       in flow below the reply.
       `@container`: the key hint steps aside when the box is narrow. */
    <div
      ref={menus.wrapRef}
      data-composer
      className="@container mt-0.5 shrink-0 px-8 pb-4"
    >
      <div className="mx-auto w-full max-w-[656px]">
        {queued}
        {/* The menus open over the box itself, never over the trays above it. */}
        <div className="relative">
          <SlashPopup menus={menus} />
          <MentionPopup
            menus={menus}
            employees={employees}
            avatar={(e) => (
              <HermesAvatar
                name={e.name}
                status={e.status}
                className="size-[18px]"
              />
            )}
          />
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
              /* An app-owned `/command` never posts — the host routed it
             (opens its picker/feature) and the box clears like a send. */
              const cmd = files.length === 0 ? parseSlashDraft(t) : null;
              if (cmd && onCommand?.(cmd.name, cmd.args)) {
                if (draftRef.current.trim() === t) setDraft("");
                return;
              }
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
              <PromptInputAttachments className="px-0 pt-0 pb-2">
                {(file) => <PromptInputAttachment data={file} />}
              </PromptInputAttachments>
            )}
            <PromptInputBody>
              <PromptInputTextarea
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  menus.onEdited();
                }}
                onKeyDown={(e) =>
                  menus.onKeyDown(e, { running: busy, onStop, lastSent })
                }
                placeholder={placeholder}
              />
            </PromptInputBody>
            <PromptInputFooter>
              {/* #590 AC-2 + #886: one row of controls — no wrap, no key
              hint; the model and access labels step aside for icons before
              the row could crowd (each hides under `@max-[480px]`). */}
              <PromptInputTools className="min-w-0 flex-1 overflow-hidden">
                {accept && <AttachButton />}
                {onModel && models?.length ? (
                  <ModelPicker
                    value={choice ?? choiceFor(models[0].id, models)}
                    models={models}
                    onChoice={onModel}
                    open={modelOpen}
                    onOpenChange={onModelOpen}
                    {...picker}
                  />
                ) : null}
                {tools}
              </PromptInputTools>
              <ComposerKbd className="hidden @min-[420px]:inline" />
              {busy && !draft.trim() && onStop && !hideStop ? (
                <StopPill onStop={onStop} />
              ) : (
                <SendPill
                  hasDraft={!!draft.trim()}
                  working={busy}
                  sending={sending}
                />
              )}
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </div>
  );
}
