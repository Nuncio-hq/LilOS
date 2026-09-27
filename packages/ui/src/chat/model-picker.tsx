import type { ChatStatus } from "ai";
import {
  CheckIcon,
  ChevronDownIcon,
  CpuIcon,
  PaperclipIcon,
  SquareIcon,
} from "lucide-react";
import { useState } from "react";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "../components/ai-elements/model-selector";
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
import type { AttachedFile, ModelOption } from "../types";

/* Provider slugs we render the models.dev logo for; anything else gets the
   generic chip — never a broken image. */
const LOGO_PROVIDERS = new Set([
  "alibaba",
  "amazon",
  "anthropic",
  "azure",
  "cerebras",
  "cohere",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "groq",
  "meta",
  "mistral",
  "moonshotai",
  "nvidia",
  "openai",
  "openrouter",
  "togetherai",
  "vercel",
  "xai",
  "zai",
]);

export function ModelLogo({ provider }: { provider?: string }) {
  return provider && LOGO_PROVIDERS.has(provider) ? (
    <ModelSelectorLogo provider={provider} className="size-3.5" />
  ) : (
    <CpuIcon className="size-3.5 text-muted-foreground" />
  );
}

// Model pick applies from the next turn (issue #30). The list is what the
// engine reported via `models.list`, grouped by provider — the app passes it in
// (no hardcoded catalog).
export function ModelPicker({
  model,
  models,
  onModel,
}: {
  model: string;
  models: ModelOption[];
  onModel: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = models.find((m) => m.id === model);
  const groups = new Map<string, ModelOption[]>();
  for (const m of models) {
    const provider = m.provider ?? "";
    groups.set(provider, [...(groups.get(provider) ?? []), m]);
  }
  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger
        render={<PromptInputButton size="sm" className="gap-1.5 text-xs" />}
      >
        <ModelLogo provider={selected?.provider} />
        <span className="max-w-36 truncate">{selected?.name ?? model}</span>
        <ChevronDownIcon className="size-3" />
      </ModelSelectorTrigger>
      <ModelSelectorContent title="Model for the next turn">
        <ModelSelectorInput placeholder="Search models…" />
        <ModelSelectorList>
          <ModelSelectorEmpty>No model found.</ModelSelectorEmpty>
          {[...groups.entries()].map(([provider, items]) => (
            <ModelSelectorGroup
              key={provider || "other"}
              heading={provider || "Other"}
            >
              {items.map((m) => (
                <ModelSelectorItem
                  key={m.id}
                  value={m.id}
                  keywords={[m.id, m.name ?? "", m.provider ?? ""]}
                  onSelect={() => {
                    onModel(m.id);
                    setOpen(false);
                  }}
                >
                  <ModelLogo provider={m.provider} />
                  <ModelSelectorName>{m.name ?? m.id}</ModelSelectorName>
                  {m.id === model && <CheckIcon className="ml-auto size-4" />}
                </ModelSelectorItem>
              ))}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}

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
  model,
  models,
  onModel,
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
  model?: string;
  models?: ModelOption[];
  /* No onModel → no model picker: the control needs its handler (issue #19). */
  onModel?: (m: string) => void;
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
                model={model ?? models[0].id}
                models={models}
                onModel={onModel}
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
