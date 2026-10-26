import { FolderIcon, GitBranchIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
} from "react";
import { useComposerMenus } from "../chat/composer-menus";
import { MentionPopup, SlashPopup } from "../chat/composer-popups";
import { parseSlashDraft } from "../chat/composer-slash";
import { cn } from "../lib/utils";
import type { FileMention, SlashItem } from "../types";
import {
  type Attach,
  AttachButton,
  AttachChips,
  pastedFiles,
} from "./v3-attach";
import { Kbd } from "./v3-bits";
import type { V3Data } from "./v3-data-types";
import { AgentAvatar, CeoMark } from "./v3-marks";
import type { V3Agent } from "./v3-types";

/* One message box for both chat pages: a textarea that grows with the text, a
   row of quiet chips that say who hears it and where it works, and Send. Where
   the app takes files (`attach`), they can be pasted, dropped or picked with
   the paperclip, and ride along with the text. Where the app can search
   (`onSearchFiles`, `onSearchCommands`), `@` offers people then files and `/`
   the engine's commands, with the keys the chat composer has. */

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
  attach,
  lastSent,
  people,
  onSearchFiles,
  onSearchCommands,
  onCommand,
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
  /** Staged files (from `useAttach`); absent where messages carry text only. */
  attach?: Attach;
  /** ↑ in an empty box brings this back: what you last sent here. */
  lastSent?: string;
  /** Who `@` offers first. Absent or empty: no people section. */
  people?: V3Agent[];
  /** Files and folders of the working folder matching the text after `@`.
      Absent: no Files section (and no `@` menu without people either). */
  onSearchFiles?: (query: string) => Promise<FileMention[]>;
  /** The engine's commands matching the text after a leading `/`. Absent:
      `/` is plain text. */
  onSearchCommands?: (query: string) => Promise<SlashItem[]>;
  /** A `/name args` send goes here first; true means the app took it (it
      opens its own picker, say) and nothing is sent. */
  onCommand?: (name: string, args: string) => boolean;
}) {
  const own = useRef<HTMLTextAreaElement>(null);
  const field = inputRef ?? own;
  const text = value.trim();
  // Files alone are a message too.
  const sendable = !!text || !!attach?.files.length;
  const menus = useComposerMenus({
    draft: value,
    setDraft: onChange,
    employees: people ?? [],
    onSearchFiles,
    onSearchCommands,
  });

  // The field is as tall as its text, up to MAX_HEIGHT, then scrolls.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value, field]);

  const submit = () => {
    if (!sendable) return;
    // A command the app owns never posts; the box clears like a send.
    const cmd = attach?.files.length ? null : parseSlashDraft(text);
    if (cmd && onCommand?.(cmd.name, cmd.args)) {
      onChange("");
      return;
    }
    onSend(text);
    onChange("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Backspace in an empty box takes the last file back out.
    if (e.key === "Backspace" && !value && attach?.files.length) {
      e.preventDefault();
      attach.remove(attach.files[attach.files.length - 1].id);
      return;
    }
    // An open menu owns its keys, Esc closes it, ↑ recalls, ⌘. is for turns.
    menus.onKeyDown(e, { lastSent });
    if (e.defaultPrevented) return;
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
      {agent.id === data.ceoId && <CeoMark />}
    </>
  );

  return (
    <div ref={menus.wrapRef} data-composer className="relative">
      <MentionPopup
        menus={menus}
        employees={people ?? []}
        avatar={(a) => <AgentAvatar data={data} agent={a} size={18} />}
        meta={(a) => a.role}
      />
      <SlashPopup menus={menus} />
      <div
        onDragOver={
          attach
            ? (e) => {
                if (e.dataTransfer.types.includes("Files")) e.preventDefault();
              }
            : undefined
        }
        onDrop={
          attach
            ? (e) => {
                if (!e.dataTransfer.types.includes("Files")) return;
                e.preventDefault();
                attach.add([...e.dataTransfer.files]);
              }
            : undefined
        }
        className="rounded-xl border border-foreground/15 px-3.5 pt-3 pb-2.5 transition-colors focus-within:border-foreground/30"
      >
        {attach && <AttachChips attach={attach} />}
        <textarea
          ref={field}
          rows={1}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            menus.onEdited();
          }}
          onKeyDown={onKeyDown}
          onPaste={
            attach
              ? (e) => {
                  const files = pastedFiles(e);
                  if (files.length === 0) return;
                  // A pasted picture is a file, not text: the box stays as it was.
                  e.preventDefault();
                  attach.add(files);
                }
              : undefined
          }
          placeholder={placeholder}
          aria-label={placeholder}
          className="block min-h-6 w-full resize-none bg-transparent text-[14.5px] text-foreground leading-normal outline-none placeholder:text-muted-foreground/70"
        />
        {/* Both rows are containers (D-#868): a narrow box — phone, side
            peek — drops the key hint and the chips' names/chevrons to bare
            marks, so the pill, folder and shield stay on one row. */}
        <div className="@container mt-2 flex items-center gap-1">
          {attach && <AttachButton attach={attach} />}
          <div className="@container flex min-w-0 flex-1 flex-wrap items-center gap-x-0.5 gap-y-1">
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
          <Kbd className="@max-sm:hidden shrink-0">⌘↵</Kbd>
          <button
            type="button"
            disabled={!sendable}
            onClick={submit}
            className={cn(
              "ml-1 inline-flex h-[26px] shrink-0 items-center rounded-[7px] border px-2.5 font-medium text-[13px] transition-[background,transform] enabled:active:scale-[0.97]",
              sendable
                ? "border-foreground bg-foreground text-background hover:bg-foreground/85"
                : "border-[var(--v3-line)] text-muted-foreground/60",
            )}
          >
            {working ? "Queue" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
