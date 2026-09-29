import {
  ClockIcon,
  DownloadIcon,
  FileIcon,
  FolderOpenIcon,
  StarIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ScrollArea } from "../components/ui/scroll-area";
import { cn } from "../lib/utils";
import { displayUrl } from "./browser-omnibox";
import type {
  BrowserBookmark,
  BrowserDownload,
  BrowserHistoryItem,
  BrowserLibraryTab,
} from "./browser-types";

const TABS: { id: BrowserLibraryTab; label: string; icon: typeof ClockIcon }[] =
  [
    { id: "history", label: "History", icon: ClockIcon },
    { id: "bookmarks", label: "Bookmarks", icon: StarIcon },
    { id: "downloads", label: "Downloads", icon: DownloadIcon },
  ];

/* History / Bookmarks / Downloads in one sheet over the page. Clicking a row
   opens it in the current tab. Each destructive control renders only when the
   app passes its handler (D-#19). */
export function BrowserLibrary({
  tab,
  onTab,
  onClose,
  history,
  bookmarks,
  downloads,
  onOpen,
  onClearHistory,
  onRemoveBookmark,
  onShowDownload,
}: {
  tab: BrowserLibraryTab;
  onTab: (t: BrowserLibraryTab) => void;
  onClose: () => void;
  history: BrowserHistoryItem[];
  bookmarks: BrowserBookmark[];
  downloads: BrowserDownload[];
  onOpen: (url: string) => void;
  onClearHistory?: () => void;
  onRemoveBookmark?: (url: string) => void;
  onShowDownload?: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const match = (t: string, u: string) =>
    !q || `${t} ${u}`.toLowerCase().includes(q.toLowerCase());

  return (
    <div
      data-browser-library={tab}
      className="absolute inset-0 z-20 flex flex-col bg-background"
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => onTab(t.id)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground",
              tab === t.id && "bg-muted font-medium text-foreground",
            )}
          >
            <t.icon className="size-3.5" />
            {t.label}
          </button>
        ))}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="Close"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      {tab !== "downloads" && (
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${tab}`}
            className="h-8"
          />
          {tab === "history" && onClearHistory && history.length > 0 && (
            <Button variant="outline" size="sm" onClick={onClearHistory}>
              Clear history
            </Button>
          )}
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2 text-[13px]">
          {tab === "history" &&
            (history.length === 0 ? (
              <Empty>No history yet.</Empty>
            ) : (
              history
                .filter((h) => match(h.title, h.url))
                .map((h, i) => (
                  <Row
                    key={`${h.url}:${i}`}
                    title={h.title}
                    url={h.url}
                    left={
                      <span className="w-12 shrink-0 text-muted-foreground text-xs tabular-nums">
                        {h.when}
                      </span>
                    }
                    onOpen={() => onOpen(h.url)}
                  />
                ))
            ))}
          {tab === "bookmarks" &&
            (bookmarks.length === 0 ? (
              <Empty>Star a page to keep it here.</Empty>
            ) : (
              bookmarks
                .filter((b) => match(b.title, b.url))
                .map((b) => (
                  <Row
                    key={b.url}
                    title={b.title}
                    url={b.url}
                    left={
                      <StarIcon className="size-3.5 shrink-0 fill-amber-400 text-amber-400" />
                    }
                    onOpen={() => onOpen(b.url)}
                    onRemove={
                      onRemoveBookmark
                        ? () => onRemoveBookmark(b.url)
                        : undefined
                    }
                  />
                ))
            ))}
          {tab === "downloads" &&
            (downloads.length === 0 ? (
              <Empty>Files you download show here.</Empty>
            ) : (
              downloads.map((d) => (
                <div
                  key={d.id}
                  data-download={d.progress === undefined ? "done" : "active"}
                  className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/60"
                >
                  <FileIcon className="size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{d.name}</div>
                    {d.progress === undefined ? (
                      <div className="text-muted-foreground text-xs">
                        {d.size}
                        {d.when && ` · ${d.when}`}
                      </div>
                    ) : (
                      <div className="mt-1 flex items-center gap-2">
                        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-blue-600 transition-[width]"
                            style={{
                              width: `${Math.round(d.progress * 100)}%`,
                            }}
                          />
                        </div>
                        <span className="text-muted-foreground text-xs tabular-nums">
                          {Math.round(d.progress * 100)}% of {d.size}
                        </span>
                      </div>
                    )}
                  </div>
                  {d.progress === undefined && onShowDownload && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Show in Finder"
                      title="Show in Finder"
                      onClick={() => onShowDownload(d.id)}
                    >
                      <FolderOpenIcon />
                    </Button>
                  )}
                </div>
              ))
            ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function Row({
  title,
  url,
  left,
  onOpen,
  onRemove,
}: {
  title: string;
  url: string;
  left: React.ReactNode;
  onOpen: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-muted/60">
      {left}
      <button
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
      >
        <span className="min-w-0 truncate">{title}</span>
        <span className="min-w-0 shrink truncate text-muted-foreground text-xs">
          {displayUrl(url)}
        </span>
      </button>
      {onRemove && (
        <button
          aria-label="Remove"
          onClick={onRemove}
          className="text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
        >
          <Trash2Icon className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 py-10 text-center text-muted-foreground">{children}</p>
  );
}
