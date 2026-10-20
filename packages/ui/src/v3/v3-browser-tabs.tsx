import { GlobeIcon, PlusIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { AgentAvatar, DOT } from "./v3-bits";
import { Favicon, NEW_TAB, tabStatus } from "./v3-browser-bits";
import { agentOf } from "./v3-model";
import type { V3BrowserTab, V3Data, V3Status } from "./v3-types";

/* The tab strip is the window's title row: your tabs first, then the tabs
   agents drive. An agent's tab wears the agent's face instead of a favicon
   and a thin status line underneath, so whose tab it is never needs reading. */

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
  onClose: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative flex h-8 w-[168px] shrink-0 items-center rounded-t-lg border border-transparent border-b-0 text-[13px] transition-colors",
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
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-t-lg pr-7 pl-2.5 text-left outline-none focus-visible:bg-[var(--v3-hover)]"
      >
        {icon}
        <span className="truncate">{title}</span>
      </button>
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

const LABEL = "shrink-0 self-center px-2 text-[12px] text-muted-foreground/70";

export function TabStrip({
  data,
  yours,
  agents,
  blank,
  shownId,
  onSelect,
  onClose,
  onNew,
}: {
  data: V3Data;
  yours: V3BrowserTab[];
  agents: V3BrowserTab[];
  /** The empty tab from + or ⌘T, before it has an address. */
  blank: boolean;
  /** Id of the tab on show; NEW_TAB for the blank one. */
  shownId?: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  // Labels only help when there are two groups to tell apart.
  const labelled = agents.length > 0 && (yours.length > 0 || blank);
  return (
    <div className="flex shrink-0 items-end gap-1 border-[var(--v3-line)] border-b bg-[var(--v3-soft)] px-2 pt-1.5">
      <div className="no-scrollbar flex min-w-0 items-end gap-0.5 overflow-x-auto">
        {labelled && <span className={LABEL}>Yours</span>}
        {yours.map((t) => (
          <TabChip
            key={t.id}
            active={t.id === shownId}
            icon={<Favicon url={t.url} />}
            title={t.title}
            tip={t.title}
            onSelect={() => onSelect(t.id)}
            onClose={() => onClose(t.id)}
          />
        ))}
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
        {agents.length > 0 && (
          <>
            {labelled && (
              <span
                aria-hidden
                className="mx-1.5 h-4 w-px shrink-0 self-center bg-[var(--v3-line)]"
              />
            )}
            <span className={LABEL}>Agents</span>
            {agents.map((t) => {
              const agent = agentOf(data, t.by);
              return (
                <TabChip
                  key={t.id}
                  active={t.id === shownId}
                  icon={<AgentAvatar data={data} agent={agent} size={16} />}
                  title={t.title}
                  tip={`${agent.name} · ${t.title}`}
                  status={tabStatus(data, t)}
                  onSelect={() => onSelect(t.id)}
                  onClose={() => onClose(t.id)}
                />
              );
            })}
          </>
        )}
      </div>
      <button
        type="button"
        aria-label="New tab"
        title="New tab (⌘T)"
        onClick={onNew}
        className="mb-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground"
      >
        <PlusIcon className="size-4" />
      </button>
    </div>
  );
}
