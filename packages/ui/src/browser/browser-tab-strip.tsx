import {
  GlobeIcon,
  Loader2Icon,
  PanelRightIcon,
  PictureInPicture2Icon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import type { EmpFn } from "../types";
import { hostOf } from "./browser-omnibox";
import type { BrowserMode, BrowserTab } from "./browser-types";

/* A site's letter chip until real favicons exist; a spinner while loading. */
export function Favicon({ tab }: { tab: BrowserTab }) {
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

/* Tabs across the top. An agent's tab carries the employee's avatar (and a
   live dot while the agent drives it) so Oscar always sees who is where.
   In window mode the strip is also the title bar (traffic lights on the left). */
export function BrowserTabStrip({
  tabs,
  activeId,
  emp,
  mode,
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
  onSelect: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  onMode?: (m: BrowserMode) => void;
  onClose: () => void;
}) {
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
      <div className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto">
        {tabs.map((t) => {
          const e = t.agent ? emp(t.agent.employeeId) : undefined;
          const active = t.id === activeId;
          return (
            <div
              key={t.id}
              data-browser-tab={t.id}
              data-agent-tab={t.agent ? t.agent.employeeId : undefined}
              data-active={active || undefined}
              onClick={() => onSelect(t.id)}
              onAuxClick={(ev) => ev.button === 1 && onCloseTab(t.id)}
              title={e ? `${e.name} · ${t.title}` : t.title}
              className={cn(
                "group flex h-8 max-w-52 min-w-24 flex-1 cursor-default items-center gap-1.5 rounded-t-lg px-2.5 text-[12.5px]",
                active
                  ? "bg-background shadow-[0_-1px_0_0_var(--border)]"
                  : "text-muted-foreground hover:bg-background/50",
              )}
            >
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
        })}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New tab"
          title="New tab (⌘T)"
          className="mb-0.5 size-7"
          onClick={onNewTab}
        >
          <PlusIcon />
        </Button>
      </div>
      <div className="mb-0.5 flex shrink-0 items-center">
        {onMode && (
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
        {mode === "panel" && (
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
