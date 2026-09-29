import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClockIcon,
  CodeIcon,
  DownloadIcon,
  EllipsisIcon,
  HandIcon,
  PanelRightIcon,
  PictureInPicture2Icon,
  PlusIcon,
  PrinterIcon,
  RotateCwIcon,
  SearchIcon,
  StarIcon,
  UserRoundPlusIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import type { EmpFn } from "../types";
import { BrowserLibrary } from "./browser-library";
import { BrowserOmnibox } from "./browser-omnibox";
import { BrowserTabStrip } from "./browser-tab-strip";
import type {
  BrowserBookmark,
  BrowserDownload,
  BrowserFind,
  BrowserHistoryItem,
  BrowserLibraryTab,
  BrowserMode,
  BrowserTab,
  BrowserThread,
} from "./browser-types";

export type BrowserPanelProps = {
  mode: BrowserMode;
  tabs: BrowserTab[];
  activeId: string;
  emp: EmpFn;
  /** Threads Oscar can hand one of his tabs to (their agent then owns it).
      Also names the tab groups. Omit to hide "Hand this tab to…". */
  threads?: BrowserThread[];
  history: BrowserHistoryItem[];
  bookmarks: BrowserBookmark[];
  downloads: BrowserDownload[];
  /** The page itself: a native view slot in LilOS.app, a fake page here. */
  page: ReactNode;
  canBack: boolean;
  canForward: boolean;
  zoom: number;
  find: BrowserFind | null;
  findCount: number;
  onFind: (f: BrowserFind | null) => void;
  onSelectTab: (id: string) => void;
  onNewTab: () => void;
  onCloseTab: (id: string) => void;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onZoom: (z: number) => void;
  onToggleBookmark?: () => void;
  onPrint?: () => void;
  onDevTools?: () => void;
  onTakeControl: (tabId: string) => void;
  onHandBack: (tabId: string) => void;
  onHandTo?: (tabId: string, threadId: string) => void;
  onMode?: (m: BrowserMode) => void;
  onClose?: () => void;
  onClearHistory?: () => void;
  onRemoveBookmark?: (url: string) => void;
  onShowDownload?: (id: string) => void;
  className?: string;
  style?: React.CSSProperties;
};

const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const stepZoom = (z: number, dir: 1 | -1) => {
  const i = ZOOMS.findIndex((x) => x >= z - 0.001);
  return ZOOMS[Math.min(Math.max((i < 0 ? 5 : i) + dir, 0), ZOOMS.length - 1)]!;
};

/* The LilOS Browser (issue #214): Oscar's everyday browser, shared with
   agents. Opens beside the chat (panel) or as its own window. Props in,
   callbacks out; the app owns pages, history and downloads. An agent's tab
   shows who drives it and what it's doing, with Take control one click away. */
export function BrowserPanel(p: BrowserPanelProps) {
  const [library, setLibrary] = useState<BrowserLibraryTab | null>(null);
  const [focusKey, setFocusKey] = useState(0);
  const tab = p.tabs.find((t) => t.id === p.activeId) ?? p.tabs[0];
  const agent = tab?.agent;
  const agentEmp = agent ? p.emp(agent.employeeId) : undefined;
  const bookmarked = !!tab && p.bookmarks.some((b) => b.url === tab.url);
  const active = p.downloads.find((d) => d.progress !== undefined);
  const newTab = () => {
    p.onNewTab();
    setLibrary(null);
    setFocusKey((k) => k + 1);
  };
  const open = (url: string) => {
    p.onNavigate(url);
    setLibrary(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    const run = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (k === "f")
      run(() => p.onFind({ query: p.find?.query ?? "", index: 0 }));
    else if (k === "t") run(newTab);
    else if (k === "w" && tab) run(() => p.onCloseTab(tab.id));
    else if (k === "l") run(() => setFocusKey((n) => n + 1));
    else if (k === "y") run(() => setLibrary("history"));
    else if (k === "=" || k === "+") run(() => p.onZoom(stepZoom(p.zoom, 1)));
    else if (k === "-") run(() => p.onZoom(stepZoom(p.zoom, -1)));
    else if (k === "0") run(() => p.onZoom(1));
    else if (k === "[") run(p.onBack);
    else if (k === "]") run(p.onForward);
    else if (k === "p" && p.onPrint) run(p.onPrint);
  };

  return (
    <section
      data-browser={p.mode}
      aria-label="LilOS Browser"
      onKeyDown={onKeyDown}
      style={p.style}
      className={cn(
        "flex min-h-0 flex-col overflow-hidden bg-background",
        p.mode === "panel" && "border-l",
        p.mode === "window" &&
          "rounded-xl border shadow-2xl ring-1 ring-black/5",
        p.className,
      )}
    >
      <BrowserTabStrip
        tabs={p.tabs}
        activeId={p.activeId}
        emp={p.emp}
        mode={p.mode}
        threads={p.threads}
        onSelect={(id) => {
          p.onSelectTab(id);
          setLibrary(null);
        }}
        onCloseTab={p.onCloseTab}
        onNewTab={newTab}
        onMode={p.onMode}
        onClose={p.onClose}
      />

      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          disabled={!p.canBack}
          onClick={p.onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Forward"
          disabled={!p.canForward}
          onClick={p.onForward}
        >
          <ArrowRightIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Reload"
          onClick={p.onReload}
        >
          <RotateCwIcon />
        </Button>
        {tab && (
          <BrowserOmnibox
            url={tab.url}
            zoom={p.zoom}
            bookmarked={bookmarked}
            tabs={p.tabs.filter((t) => t.id !== tab.id)}
            bookmarks={p.bookmarks}
            history={p.history}
            focusKey={focusKey}
            onNavigate={open}
            onSwitchTab={p.onSelectTab}
            onToggleBookmark={p.onToggleBookmark}
            onResetZoom={() => p.onZoom(1)}
          />
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Downloads"
          title="Downloads"
          data-downloads-button={active ? "active" : undefined}
          onClick={() =>
            setLibrary(library === "downloads" ? null : "downloads")
          }
          className="relative"
        >
          {active && (
            <span
              className="absolute inset-0.5 rounded-full"
              style={{
                background: `conic-gradient(rgb(37 99 235) ${(active.progress ?? 0) * 360}deg, transparent 0)`,
                mask: "radial-gradient(circle, transparent 58%, black 60%)",
              }}
            />
          )}
          <DownloadIcon />
        </Button>
        {p.onHandTo &&
          p.threads?.length &&
          p.mode !== "thread" &&
          tab &&
          !agent && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Hand this tab to a thread"
                    title="Hand this tab to…"
                    data-hand-to
                  />
                }
              >
                <UserRoundPlusIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Hand this tab to…</DropdownMenuLabel>
                  {p.threads.map((th) => {
                    const e = p.emp(th.employeeId);
                    return (
                      <DropdownMenuItem
                        key={th.id}
                        data-hand-to-thread={th.id}
                        onClick={() => p.onHandTo?.(tab.id, th.id)}
                      >
                        <HermesAvatar
                          name={e?.name}
                          status={e?.status}
                          className="size-5"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{th.title}</span>
                          <span className="block text-muted-foreground text-xs">
                            {e?.name}
                          </span>
                        </span>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Browser menu"
                data-browser-menu
              />
            }
          >
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onClick={newTab}>
              <PlusIcon /> New tab{" "}
              <DropdownMenuShortcut>⌘T</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setLibrary("history")}>
              <ClockIcon /> History{" "}
              <DropdownMenuShortcut>⌘Y</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setLibrary("bookmarks")}>
              <StarIcon /> Bookmarks
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setLibrary("downloads")}>
              <DownloadIcon /> Downloads
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => p.onFind({ query: p.find?.query ?? "", index: 0 })}
            >
              <SearchIcon /> Find in page{" "}
              <DropdownMenuShortcut>⌘F</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => p.onZoom(stepZoom(p.zoom, 1))}>
              <ZoomInIcon /> Zoom in{" "}
              <DropdownMenuShortcut>⌘+</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => p.onZoom(stepZoom(p.zoom, -1))}>
              <ZoomOutIcon /> Zoom out{" "}
              <DropdownMenuShortcut>⌘−</DropdownMenuShortcut>
            </DropdownMenuItem>
            {p.onPrint && (
              <DropdownMenuItem onClick={p.onPrint}>
                <PrinterIcon /> Print…{" "}
                <DropdownMenuShortcut>⌘P</DropdownMenuShortcut>
              </DropdownMenuItem>
            )}
            {p.onDevTools && (
              <DropdownMenuItem onClick={p.onDevTools}>
                <CodeIcon /> Developer tools{" "}
                <DropdownMenuShortcut>⌥⌘I</DropdownMenuShortcut>
              </DropdownMenuItem>
            )}
            {p.onMode && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() =>
                    p.onMode?.(p.mode === "panel" ? "window" : "panel")
                  }
                >
                  {p.mode === "panel" ? (
                    <PictureInPicture2Icon />
                  ) : (
                    <PanelRightIcon />
                  )}
                  {p.mode === "panel"
                    ? "Pop out into a window"
                    : "Dock beside the chat"}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {agent && agentEmp && (
        <div
          data-agent-banner={agent.control}
          className={cn(
            "flex shrink-0 items-center gap-2.5 border-b px-3 py-2 text-[13px]",
            agent.control === "agent"
              ? "bg-violet-50 dark:bg-violet-950/40"
              : "bg-amber-50 dark:bg-amber-950/30",
          )}
        >
          <HermesAvatar name={agentEmp.name} className="size-5" />
          {agent.control === "agent" ? (
            <span className="min-w-0 flex-1 truncate">
              <b className="font-semibold">{agentEmp.name}</b> is using this tab
              {agent.action && (
                <span className="text-muted-foreground"> · {agent.action}</span>
              )}
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate">
              <b className="font-semibold">You have control.</b>{" "}
              <span className="text-muted-foreground">
                {agentEmp.name} waits until you hand it back.
              </span>
            </span>
          )}
          {agent.control === "agent" ? (
            <Button
              size="sm"
              data-take-control
              onClick={() => tab && p.onTakeControl(tab.id)}
              className="h-7 gap-1.5"
            >
              <HandIcon className="size-3.5" /> Take control
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              data-hand-back
              onClick={() => tab && p.onHandBack(tab.id)}
              className="h-7"
            >
              Hand back to {agentEmp.name}
            </Button>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="absolute inset-0 overflow-auto">{p.page}</div>
        {agent?.control === "agent" && (
          <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_2px_rgb(139_92_246/0.7),inset_0_0_24px_rgb(139_92_246/0.25)]" />
        )}
        {p.find && (
          <FindBar find={p.find} count={p.findCount} onFind={p.onFind} />
        )}
        {library && (
          <BrowserLibrary
            tab={library}
            onTab={setLibrary}
            onClose={() => setLibrary(null)}
            history={p.history}
            bookmarks={p.bookmarks}
            downloads={p.downloads}
            onOpen={open}
            onClearHistory={p.onClearHistory}
            onRemoveBookmark={p.onRemoveBookmark}
            onShowDownload={p.onShowDownload}
          />
        )}
      </div>
    </section>
  );
}

function FindBar({
  find,
  count,
  onFind,
}: {
  find: BrowserFind;
  count: number;
  onFind: (f: BrowserFind | null) => void;
}) {
  const move = (d: 1 | -1) =>
    count > 0 && onFind({ ...find, index: (find.index + d + count) % count });
  return (
    <div
      data-find-bar
      className="absolute top-2 right-3 z-10 flex items-center gap-1 rounded-lg border bg-popover py-1 pr-1 pl-2.5 text-[13px] shadow-lg"
    >
      <input
        // biome-ignore lint/a11y/noAutofocus: ⌘F moves focus into the find field, as every browser does.
        autoFocus
        aria-label="Find in page"
        value={find.query}
        placeholder="Find in page"
        onChange={(e) => onFind({ query: e.target.value, index: 0 })}
        onKeyDown={(e) => {
          if (e.key === "Enter") move(e.shiftKey ? -1 : 1);
          if (e.key === "Escape") onFind(null);
        }}
        className="w-40 bg-transparent outline-none"
      />
      <span className="w-14 text-right text-muted-foreground text-xs tabular-nums">
        {find.query ? `${count ? find.index + 1 : 0} of ${count}` : ""}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Previous match"
        onClick={() => move(-1)}
      >
        <ChevronUpIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Next match"
        onClick={() => move(1)}
      >
        <ChevronDownIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Close find"
        onClick={() => onFind(null)}
      >
        <XIcon />
      </Button>
    </div>
  );
}
