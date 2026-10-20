import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  EllipsisIcon,
  PencilIcon,
} from "lucide-react";
import { type ReactNode, type RefObject, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { EscLayer, useMenu } from "./v3-keys";

/* A thread's quiet ⋯ menu and its inline title editor: rename in place, put
   away, bring back. The menu draws only the items the app can do
   (`act.renameThread`, `act.archiveThread`); with neither there is no menu at
   all. Every row on Threads and the thread's own header use the same pair. */

const ITEM =
  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-foreground outline-none hover:bg-[var(--v3-hover)] focus-visible:bg-[var(--v3-hover)] [&_svg]:size-3.5 [&_svg]:text-muted-foreground";

/** The ⋯ button and its menu. Rows are clickable, so every click and key in
    here stays here (a menu item must not also open the thread). */
export function ThreadMenu({
  archived,
  onRename,
  onArchive,
  quiet,
  className,
  triggerRef,
}: {
  archived?: boolean;
  onRename?: () => void;
  onArchive?: () => void;
  /** For a caller that puts the keyboard back on the ⋯ button itself (after
      renaming in place). */
  triggerRef?: RefObject<HTMLButtonElement | null>;
  /** In a list row: drawn only while the row is hovered or focused (the
      row is `group/thread`). Off, as in a thread's own header, it always shows. */
  quiet?: boolean;
  className?: string;
}) {
  const { open, setOpen, trigger, list, onKeyDown } = useMenu(triggerRef);
  if (!onRename && !onArchive) return null;

  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };

  return (
    <span
      className={cn("relative shrink-0", className)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        ref={trigger}
        type="button"
        aria-label="Thread actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "grid size-6 place-items-center rounded-md text-muted-foreground outline-none transition-opacity hover:bg-[var(--v3-hover)] hover:text-foreground",
          quiet &&
            "opacity-0 focus-visible:opacity-100 group-focus-within/thread:opacity-100 group-hover/thread:opacity-100 [@media(hover:none)]:opacity-100",
          open && "bg-[var(--v3-hover)] opacity-100",
        )}
      >
        <EllipsisIcon className="size-4" />
      </button>
      {open && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Close thread actions"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            ref={list}
            role="menu"
            aria-label="Thread actions"
            tabIndex={-1}
            onKeyDown={onKeyDown}
            className="absolute top-full right-0 z-20 mt-1 min-w-[176px] rounded-lg border border-[var(--v3-line)] bg-background py-1 text-[13.5px]"
          >
            {onRename && (
              <button
                type="button"
                role="menuitem"
                onClick={pick(onRename)}
                className={ITEM}
              >
                <PencilIcon />
                Rename thread
              </button>
            )}
            {onArchive && (
              <button
                type="button"
                role="menuitem"
                onClick={pick(onArchive)}
                className={ITEM}
              >
                {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                {archived ? "Unarchive thread" : "Archive thread"}
              </button>
            )}
          </div>
        </>
      )}
    </span>
  );
}

/** The title being renamed. Enter or leaving the box saves; Esc keeps the old
    title. An empty or unchanged title is not a rename. `onDone(byKey)` says
    whether the keyboard ended it (Enter, Esc): then focus should come back to
    where the rename began; after a click elsewhere it stays where you clicked. */
export function TitleInput({
  value,
  onSave,
  onDone,
  className,
}: {
  value: string;
  onSave: (title: string) => void;
  onDone: (byKey: boolean) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  // Leaving the box also fires blur once Enter or Esc has already decided.
  const decided = useRef(false);
  const finish = (save: boolean, byKey = true) => {
    if (decided.current) return;
    decided.current = true;
    const next = draft.trim();
    if (save && next && next !== value) onSave(next);
    onDone(byKey);
  };
  return (
    <>
      {/* Esc through the layer stack, like every other panel: a view behind
          this box (the widened thread) must not take the key first and close,
          which would also unmount the box and save what Esc cancels. */}
      <EscLayer onEscape={() => finish(false)} />
      <input
        // biome-ignore lint/a11y/noAutofocus: it opens because you asked to rename
        autoFocus
        aria-label="Thread title"
        value={draft}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key !== "Enter") return;
          // Focus returns to the ⋯ button as the box closes; this Enter must
          // not also click it and open the menu.
          e.preventDefault();
          finish(true);
        }}
        onBlur={() => finish(true, false)}
        className={cn(
          "h-7 min-w-0 flex-1 rounded-[7px] border border-foreground/25 bg-background px-2 text-foreground outline-none [font-family:inherit] [font-size:inherit] [font-weight:inherit] focus:border-foreground/45",
          className,
        )}
      />
    </>
  );
}

/** Rename state plus the menu for one thread, wherever its title shows (a
    list row, a thread's header). `input` replaces the title while it is being
    renamed and is undefined otherwise (draw the title yourself then); `menu`
    is undefined when the app can do neither action. */
export function useRenameMenu({
  title,
  archived = false,
  quiet = false,
  inputClassName,
  onRename,
  onArchive,
}: {
  title: string;
  archived?: boolean;
  quiet?: boolean;
  /** Sizes the input to the title it replaces. */
  inputClassName?: string;
  onRename?: (title: string) => void;
  onArchive?: (archived: boolean) => void;
}): { input: ReactNode | undefined; menu: ReactNode | undefined } {
  const [editing, setEditing] = useState(false);
  // Renaming comes from the ⋯ menu: finishing by key puts the keyboard back on
  // its button, as closing the menu would.
  const trigger = useRef<HTMLButtonElement>(null);
  const input =
    editing && onRename ? (
      <TitleInput
        value={title}
        onSave={onRename}
        onDone={(byKey) => {
          setEditing(false);
          if (byKey) trigger.current?.focus();
        }}
        className={inputClassName}
      />
    ) : undefined;
  const menu =
    onRename || onArchive ? (
      <ThreadMenu
        triggerRef={trigger}
        quiet={quiet}
        archived={archived}
        onRename={onRename ? () => setEditing(true) : undefined}
        onArchive={onArchive ? () => onArchive(!archived) : undefined}
      />
    ) : undefined;
  return { input, menu };
}
