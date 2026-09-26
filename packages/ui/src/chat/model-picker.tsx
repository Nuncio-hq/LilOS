import type { ChatStatus } from "ai";
import { CheckIcon, ChevronDownIcon, CpuIcon, SquareIcon } from "lucide-react";
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
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "../components/ai-elements/prompt-input";
import type { ModelOption } from "../types";

export function ModelLogo({ model }: { model: string }) {
  const p = model.startsWith("qwen")
    ? "alibaba"
    : model.startsWith("claude")
      ? "anthropic"
      : model.startsWith("gpt")
        ? "openai"
        : null;
  return p ? (
    <ModelSelectorLogo provider={p} className="size-3.5" />
  ) : (
    <CpuIcon className="size-3.5 text-muted-foreground" />
  );
}

// Session model. Real app: slash.exec "/model <id>" on this session (applies from the next turn).
// The model list comes from the app (no mock data in here).
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
  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger
        render={<PromptInputButton size="sm" className="gap-1.5 text-xs" />}
      >
        <ModelLogo model={model} />
        <span className="max-w-36 truncate">{model.split(" ")[0]}</span>
        <ChevronDownIcon className="size-3" />
      </ModelSelectorTrigger>
      <ModelSelectorContent title="Model for this session">
        <ModelSelectorInput placeholder="Search models…" />
        <ModelSelectorList>
          <ModelSelectorEmpty>No model found.</ModelSelectorEmpty>
          <ModelSelectorGroup heading="Hermes providers · applies from the next turn">
            {models.map((m) => (
              <ModelSelectorItem
                key={m}
                value={m}
                onSelect={() => {
                  onModel(m);
                  setOpen(false);
                }}
              >
                <ModelLogo model={m} />
                <ModelSelectorName>{m}</ModelSelectorName>
                {m === model && <CheckIcon className="ml-auto size-4" />}
              </ModelSelectorItem>
            ))}
          </ModelSelectorGroup>
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
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
}: {
  running: boolean;
  status: ChatStatus;
  placeholder: string;
  hint: string;
  model?: string;
  models?: ModelOption[];
  /* No onModel → no model picker: the control needs its handler (issue #19). */
  onModel?: (m: string) => void;
  onSend: (t: string) => void;
  onStop?: () => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    // While the employee works, Enter steers the turn (session.steer — the default and only behavior;
    // the running-state placeholder/hint come from the shared runningComposer in agent-chat.tsx).
    <div>
      <PromptInput
        onSubmit={({ text }) => {
          const t = text.trim() || draft.trim();
          if (t) onSend(t);
          setDraft("");
        }}
      >
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
            {onModel && models?.length ? (
              <ModelPicker
                model={model ?? models[0]}
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
