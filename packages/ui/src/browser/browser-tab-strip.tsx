import {
  GlobeIcon,
  Loader2Icon,
  PanelRightIcon,
  PictureInPicture2Icon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { Fragment, useState } from "react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import type { EmpFn } from "../types";
import { hostOf } from "./browser-omnibox";
import type { BrowserMode, BrowserTab, BrowserThread } from "./browser-types";

/* A site's letter chip until real favicons exist; a spinner while loading. */
function Favicon({ tab }: { tab: BrowserTab }) {
  if (tab.loading)
    return (
      <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
    );
  if (tab.url.startsWith("lilos://"))
    return <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  const letter = hostOf(tab.url).replace(/^www\./, "")[0] ?? "?";
  return (
    <span className="grid size-4 shrink-0 place-items-center rounded bg-foreground/10 font-semibold text-[10px] uppercase">
      {letter}
    </span>
  );
}

/* Tabs across the top. the user's own tabs come first; every thread's tabs
   follow as a group chip (employee avatar + thread title + count, a live dot
   while its agent drives) that folds open on click, like Chrome tab groups.
   In thread mode (a thread's Workbench) all tabs belong to that one thread,
   so there are no groups. In window mode the strip is also the title bar. */
export function BrowserTabStrip({
  tabs,
  activeId,
  emp,
  mode,
  threads,
  onSelect,
  onCloseTab,
  onNewTab,
  onMode,
  onClose,
}: {
  tabs: BrowserTab[];
  activeId: string;
  emp: EmpFn;
  mode: BrowserMode;
  threads?: BrowserThread[];
  onSelect: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  onMode?: (m: BrowserMode) => void;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const grouped = mode !== "thread";
  const own = grouped ? tabs.filter((t) => !t.agent) : tabs;
  const groups: { id: string; tabs: BrowserTab[] }[] = [];
  if (grouped)
    for (const t of tabs) {
      if (!t.agent) continue;
      const g = groups.find((x) => x.id === t.agent?.threadId);
      if (g) g.tabs.push(t);
      else groups.push({ id: t.agent.threadId, tabs: [t] });
    }
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const tab = (t: BrowserTab) => (
    <TabChip
      key={t.id}
      t={t}
      active={t.id === activeId}
      emp={emp}
      onSelect={onSelect}
      onCloseTab={onCloseTab}
    />
  );

  return (
    <div className="flex h-10 shrink-0 items-end gap-1 bg-muted/60 px-2 pt-1.5">
      {mode === "window" && (
        <div className="mr-2 flex h-7 items-center gap-2 self-center pl-1">
          <button
            aria-label="Close window"
            onClick={onClose}
            className="size-3 rounded-full bg-[#ff5f57]"
          />
          <span className="size-3 rounded-full bg-[#febc2e]" />
          <span className="size-3 rounded-full bg-[#28c840]" />
        </div>
      )}
      <div className="no-scrollbar flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto [mask-image:linear-gradient(to_right,#000_calc(100%-24px),transparent)]">
        {own.map(tab)}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New tab"
          title="New tab (⌘T)"
          className="mb-0.5 size-7 shrink-0"
          onClick={onNewTab}
        >
          <PlusIcon />
        </Button>
        {groups.length > 0 && (
          <span className="mx-1 mb-2 h-4 w-px shrink-0 bg-border" />
        )}
        {groups.map((g) => {
          const th = threads?.find((x) => x.id === g.id);
          const e = emp(g.tabs[0]!.agent!.employeeId);
          const expanded =
            open.has(g.id) || g.tabs.some((t) => t.id === activeId);
          const driving = g.tabs.some((t) => t.agent?.control === "agent");
          return (
            <Fragment key={g.id}>
              <button
                data-tab-group={g.id}
                data-expanded={expanded || undefined}
                onClick={() => toggle(g.id)}
                title={`${e?.name ?? "Agent"} · ${th?.title ?? "Thread"} · ${g.tabs.length} tab${g.tabs.length === 1 ? "" : "s"}`}
                className={cn(
                  "mb-1 flex h-6 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[11.5px]",
                  "bg-violet-100 text-violet-900 hover:bg-violet-200 dark:bg-violet-900/50 dark:text-violet-100 dark:hover:bg-violet-900/70",
                )}
              >
                <span className="relative shrink-0">
                  <HermesAvatar name={e?.name} className="size-4" />
                  {driving && (
                    <span className="absolute -right-0.5 -bottom-0.5 size-1.5 animate-pulse rounded-full bg-violet-500 ring-1 ring-background" />
                  )}
                </span>
                {expanded && (
                  <span className="min-w-0 truncate font-medium">
                    {th?.title ?? e?.name}
                  </span>
                )}
                <span className="shrink-0 rounded bg-violet-500/15 px-1 tabular-nums">
                  {g.tabs.length}
                </span>
              </button>
              {expanded && g.tabs.map(tab)}
            </Fragment>
          );
        })}
      </div>
      <div className="mb-0.5 flex shrink-0 items-center">
        {onMode && mode !== "thread" && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7"
            data-browser-mode-toggle
            aria-label={
              mode === "panel"
                ? "Pop out into a window"
                : "Dock beside the chat"
            }
            title={
              mode === "panel"
                ? "Pop out into a window"
                : "Dock beside the chat"
            }
            onClick={() => onMode(mode === "panel" ? "window" : "panel")}
          >
            {mode === "panel" ? <PictureInPicture2Icon /> : <PanelRightIcon />}
          </Button>
        )}
        {mode === "panel" && onClose && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7"
            aria-label="Close browser"
            title="Close browser (⌘⇧B)"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        )}
      </div>
    </div>
  );
}

function TabChip({
  t,
  active,
  emp,
  onSelect,
  onCloseTab,
}: {
  t: BrowserTab;
  active: boolean;
  emp: EmpFn;
  onSelect: (id: string) => void;
  onCloseTab: (id: string) => void;
}) {
  const e = t.agent ? emp(t.agent.employeeId) : undefined;
  return (
    <div
      data-browser-tab={t.id}
      data-agent-tab={t.agent ? t.agent.employeeId : undefined}
      data-active={active || undefined}
      onClick={() => onSelect(t.id)}
      onAuxClick={(ev) => ev.button === 1 && onCloseTab(t.id)}
      title={e ? `${e.name} · ${t.title}` : t.title}
      className={cn(
        "group relative flex h-8 max-w-52 min-w-24 flex-1 cursor-default items-center gap-1.5 rounded-t-lg px-2.5 text-[12.5px]",
        active
          ? "bg-background shadow-[0_-1px_0_0_var(--border)]"
          : "text-muted-foreground hover:bg-background/50",
        t.agent && !active && "bg-violet-500/8",
      )}
    >
      {t.agent && (
        <span className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-violet-400" />
      )}
      {e ? (
        <span className="relative shrink-0">
          <HermesAvatar name={e.name} className="size-4" />
          {t.agent?.control === "agent" && (
            <span className="absolute -right-0.5 -bottom-0.5 size-1.5 animate-pulse rounded-full bg-violet-500 ring-1 ring-background" />
          )}
        </span>
      ) : (
        <Favicon tab={t} />
      )}
      <span className="min-w-0 flex-1 truncate">{t.title}</span>
      <button
        aria-label={`Close ${t.title}`}
        onClick={(ev) => {
          ev.stopPropagation();
          onCloseTab(t.id);
        }}
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded hover:bg-muted",
          !active && "opacity-0 group-hover:opacity-100",
        )}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}
