import { FolderIcon, GitBranchIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
} from "react";
import { cn } from "../lib/utils";
import { AgentAvatar, Kbd } from "./v3-bits";
import type { V3Agent, V3Data } from "./v3-types";

/* One message box for both chat pages: a textarea that grows with the text, a
   row of quiet chips that say who hears it and where it works, and Send. */

const MAX_HEIGHT = 180;

const CHIP =
  "inline-flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[12.5px] text-muted-foreground";

export function Composer({
  data,
  agent,
  model,
  folder,
  branch,
  working,
  value,
  onChange,
  onSend,
  onAgent,
  chips,
  inputRef,
}: {
  data: V3Data;
  agent: V3Agent;
  /** Absent or empty for an outside worker or an engine default: no chip. */
  model?: string;
  /** Absent = the harness's default folder: no chip. */
  folder?: string;
  branch?: string;
  /** The agent is mid-turn: a message waits for the current step. */
  working?: boolean;
  value: string;
  onChange: (text: string) => void;
  onSend: (text: string) => void;
  /** Makes the agent chip a link; absent where another control picks the agent. */
  onAgent?: () => void;
  /** Replaces the quiet chips (agent, model, folder, branch) with the
     caller's own, e.g. menus that choose them before the chat exists. */
  chips?: ReactNode;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const own = useRef<HTMLTextAreaElement>(null);
  const field = inputRef ?? own;
  const text = value.trim();

  // The field is as tall as its text, up to MAX_HEIGHT, then scrolls.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value, field]);

  const submit = () => {
    if (!text) return;
    onSend(text);
    onChange("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter and ⌘Enter send; Shift+Enter keeps writing. Mid-IME Enter confirms a word.
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    submit();
  };

  const placeholder = `Message ${agent.name}…${working ? " it reads this after the current step" : ""}`;
  const who = (
    <>
      <AgentAvatar data={data} agent={agent} size={16} />
      <span className="truncate">{agent.name}</span>
    </>
  );

  return (
    <div className="rounded-xl border border-foreground/15 px-3.5 pt-3 pb-2.5 transition-colors focus-within:border-foreground/30">
      <textarea
        ref={field}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={placeholder}
        className="block min-h-6 w-full resize-none bg-transparent text-[14.5px] text-foreground leading-normal outline-none placeholder:text-muted-foreground/70"
      />
      <div className="mt-2 flex items-center gap-1">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-0.5 gap-y-1">
          {chips ?? (
            <>
              {onAgent ? (
                <button
                  type="button"
                  onClick={onAgent}
                  title={`Open ${agent.name}`}
                  className={cn(
                    CHIP,
                    "hover:bg-[var(--v3-hover)] hover:text-foreground",
                  )}
                >
                  {who}
                </button>
              ) : (
                <span className={CHIP}>{who}</span>
              )}
              {model && <span className={CHIP}>{model}</span>}
              {folder && (
                <span className={CHIP} title={folder}>
                  <FolderIcon className="size-3.5 shrink-0" />
                  <span className="truncate font-mono text-[12px]">
                    {folder}
                  </span>
                </span>
              )}
              {branch && (
                <span className={CHIP} title={branch}>
                  <GitBranchIcon className="size-3.5 shrink-0" />
                  <span className="truncate font-mono text-[12px]">
                    {branch}
                  </span>
                </span>
              )}
            </>
          )}
        </div>
        <Kbd className="shrink-0">⌘↵</Kbd>
        <button
          type="button"
          disabled={!text}
          onClick={submit}
          className={cn(
            "ml-1 inline-flex h-[26px] shrink-0 items-center rounded-[7px] border px-2.5 font-medium text-[13px] transition-[background,transform] enabled:active:scale-[0.97]",
            text
              ? "border-foreground bg-foreground text-background hover:bg-foreground/85"
              : "border-[var(--v3-line)] text-muted-foreground/60",
          )}
        >
          {working ? "Queue" : "Send"}
        </button>
      </div>
    </div>
  );
}
