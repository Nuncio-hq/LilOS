import type { ChatStatus } from "ai";
import { SquareIcon } from "lucide-react";
import { useState } from "react";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "../components/ai-elements/prompt-input";
import { HermesAvatar } from "../shell/avatars";
import type { Employee } from "../types";

export function Composer({
  placeholder,
  employees,
  hint,
  onSend,
  status = "ready",
  onStop,
  tools,
  queued,
}: {
  placeholder: string;
  employees: Employee[];
  hint: string;
  onSend?: (text: string) => void;
  status?: ChatStatus;
  onStop?: () => void;
  tools?: React.ReactNode;
  queued?: React.ReactNode;
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
      <PromptInput
        onSubmit={({ text }) => {
          const t = text.trim() || draft.trim();
          if (t) onSend?.(t);
          setDraft("");
        }}
      >
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
            <PromptInputSubmit
              disabled={!draft.trim()}
              status={busy ? undefined : status}
            />
          )}
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
