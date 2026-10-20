import { GlobeIcon, PlusIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { AgentAvatar, DOT } from "./v3-bits";
import { NEW_TAB, tabStatus } from "./v3-browser-bits";
import { agentNameOf, agentOf } from "./v3-model";
import type { V3BrowserTab, V3Data, V3Status } from "./v3-types";

/* The session browser's tab strip: this session's tabs in the order they were
   opened. An agent's tab wears the agent's face and a thin status line
   underneath, yours a globe, so whose tab it is never needs reading. */

function TabChip({
  active,
  icon,
  title,
  tip,
  status,
  onSelect,
  onClose,
}: {
  active: boolean;
  icon: ReactNode;
  title: string;
  tip: string;
  /** Agent tabs: the colour of the line under the tab. */
  status?: V3Status;
  onSelect: () => void;
  /** Absent when the app cannot close tabs: then there is no ✕. */
  onClose?: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative flex h-8 w-[152px] shrink-0 items-center rounded-t-lg border border-transparent border-b-0 text-[13px] transition-colors",
        active
          ? "border-[var(--v3-line)] bg-background text-foreground"
          : "text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground",
      )}
    >
      <button
        type="button"
        title={tip}
        aria-current={active ? "page" : undefined}
        onClick={onSelect}
        className={cn(
          "flex h-full min-w-0 flex-1 items-center gap-2 rounded-t-lg pl-2.5 text-left outline-none focus-visible:bg-[var(--v3-hover)]",
          onClose ? "pr-7" : "pr-2.5",
        )}
      >
        {icon}
        <span className="truncate">{title}</span>
      </button>
      {onClose && (
        <button
          type="button"
          aria-label={`Close ${title}`}
          onClick={onClose}
          className={cn(
            "absolute right-1 grid size-5 place-items-center rounded text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground focus-visible:opacity-100",
            !active && "opacity-0 group-hover:opacity-100",
          )}
        >
          <XIcon className="size-3" />
        </button>
      )}
      {status && (
        <span
          aria-hidden
          className={cn(
            "absolute inset-x-2.5 bottom-px h-[2px] rounded-full",
            DOT[status],
            status === "working" && "lilos-v2-breathe",
          )}
        />
      )}
    </div>
  );
}

export function TabStrip({
  data,
  tabs,
  blank,
  shownId,
  onSelect,
  onClose,
  closable,
  onNew,
}: {
  data: V3Data;
  tabs: V3BrowserTab[];
  /** The empty tab from +, before it has an address. */
  blank: boolean;
  /** Id of the tab on show; NEW_TAB for the blank one. */
  shownId?: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** The app can close the tabs it holds; without it they have no ✕ (the
     blank tab is local, so it always has one). */
  closable: boolean;
  /** Absent when the app cannot open pages: then there is no +. */
  onNew?: () => void;
}) {
  return (
    <div className="flex shrink-0 items-end gap-1 border-[var(--v3-line)] border-b bg-[var(--v3-soft)] px-2 pt-1.5">
      <div className="no-scrollbar flex min-w-0 items-end gap-0.5 overflow-x-auto">
        {tabs.map((t) =>
          t.by === "you" ? (
            <TabChip
              key={t.id}
              active={t.id === shownId}
              icon={
                <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />
              }
              title={t.title}
              tip={t.title}
              onSelect={() => onSelect(t.id)}
              onClose={closable ? () => onClose(t.id) : undefined}
            />
          ) : (
            <TabChip
              key={t.id}
              active={t.id === shownId}
              icon={
                <AgentAvatar
                  data={data}
                  agent={agentOf(data, t.by)}
                  size={16}
                />
              }
              title={t.title}
              tip={`${agentNameOf(data, t.by)} · ${t.title}`}
              status={tabStatus(data, t)}
              onSelect={() => onSelect(t.id)}
              onClose={closable ? () => onClose(t.id) : undefined}
            />
          ),
        )}
        {blank && (
          <TabChip
            active={shownId === NEW_TAB}
            icon={
              <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />
            }
            title="New tab"
            tip="New tab"
            onSelect={() => onSelect(NEW_TAB)}
            onClose={() => onClose(NEW_TAB)}
          />
        )}
      </div>
      {onNew && (
        <button
          type="button"
          aria-label="New tab"
          title="New tab"
          onClick={onNew}
          className="mb-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground"
        >
          <PlusIcon className="size-4" />
        </button>
      )}
    </div>
  );
}
