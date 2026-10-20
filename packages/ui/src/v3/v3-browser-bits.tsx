import { GlobeIcon, HandIcon, LockIcon, Undo2Icon } from "lucide-react";
import { cn } from "../lib/utils";
import { AgentAvatar, Btn, Kbd, StatusDot } from "./v3-bits";
import { agentOf } from "./v3-model";
import type { V3BrowserTab, V3Data, V3PageProps, V3Status } from "./v3-types";

/* Small pieces of the LilOS Browser page: address helpers, the page body,
   the agent banner and the start view. */

/** Id of the blank tab you opened with + or ⌘T, before it has an address. */
export const NEW_TAB = "new-tab";

const SEARCH = "https://search.example/?q=";

/** What the address bar does with typed text: a URL-looking input opens that
   address (http for localhost), anything else searches. */
export function resolveInput(text: string): string {
  const t = text.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
  if (!/\s/.test(t) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(t))
    return `https://${t}`;
  return SEARCH + encodeURIComponent(t).replace(/%20/g, "+");
}

const stripScheme = (url: string) =>
  url.replace(/^https?:\/\//i, "").replace(/\/$/, "");

/** The address as the bar shows it when not editing: a search reads as the
   words you searched, anything else without scheme or trailing slash. */
export function displayUrl(url: string): string {
  if (url.startsWith(SEARCH))
    return decodeURIComponent(url.slice(SEARCH.length).replace(/\+/g, " "));
  return stripScheme(url);
}

export const hostOf = (url: string) =>
  stripScheme(url)
    .split(/[/?#]/)[0]
    .replace(/^www\./, "");

/** One key per page, so bookmarks and recents agree on what is the same. */
export const urlKey = (url: string) => stripScheme(url).toLowerCase();

/** What an agent's tab is doing, as a status: taking it over pauses the
   agent; otherwise it follows the thread that drives the tab. */
export function tabStatus(data: V3Data, tab: V3BrowserTab): V3Status {
  if (tab.takenOver) return "idle";
  const s = data.threads.find((t) => t.id === tab.threadId)?.status;
  return s && s !== "done" && s !== "planned" ? s : "working";
}

/** A site's letter chip until real favicons exist. */
export function Favicon({
  url,
  className,
}: {
  url: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-[4px] bg-[var(--v3-hover)] font-medium text-[10px] text-muted-foreground uppercase",
        className,
      )}
    >
      {hostOf(url).charAt(0) || "·"}
    </span>
  );
}

export type BrowserLink = { title: string; url: string };

function QuickLinks({
  links,
  onOpen,
}: {
  links: BrowserLink[];
  onOpen: (url: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-1.5 @min-[560px]:grid-cols-2">
      {links.map((l) => (
        <button
          key={l.url}
          type="button"
          onClick={() => onOpen(l.url)}
          className="flex min-w-0 items-center gap-2.5 rounded-lg border border-[var(--v3-line)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--v3-hover)]"
        >
          <Favicon url={l.url} className="size-5 text-[11px]" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-[13.5px] text-foreground">
              {l.title}
            </span>
            <span className="block truncate text-[12.5px] text-muted-foreground/70">
              {hostOf(l.url)}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** A tab with nowhere to go yet: the blank tab you just opened, or the
   window with no tabs at all. Bookmarks are one click away in both. */
export function StartView({
  empty,
  links,
  onNew,
  onOpen,
}: {
  empty: boolean;
  links: BrowserLink[];
  onNew: () => void;
  onOpen: (url: string) => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col items-center px-6 pt-[12vh] pb-16 text-center">
      <GlobeIcon
        className="size-7 text-muted-foreground/60"
        strokeWidth={1.5}
      />
      <h2 className="mt-3 font-semibold text-[17px] text-foreground">
        {empty ? "No tabs open" : "New tab"}
      </h2>
      <p className="mt-1 text-[14px] text-muted-foreground">
        {empty
          ? "Type an address above, or open a bookmark."
          : "Type a search or an address above, or open a bookmark."}
      </p>
      {empty && (
        <div className="mt-4">
          <Btn onClick={onNew}>
            New tab <Kbd>⌘T</Kbd>
          </Btn>
        </div>
      )}
      {links.length > 0 && (
        <div className="mt-8 w-full text-left">
          <p className="mb-2 text-[12.5px] text-muted-foreground/70">
            Bookmarks
          </p>
          <QuickLinks links={links} onOpen={onOpen} />
        </div>
      )}
    </div>
  );
}

/** A calm rendering of the page's lines (the prototype has no real pages):
   the site on top, the first line as the heading, the rest as cards. */
export function PageBody({ tab }: { tab: V3BrowserTab }) {
  const [head, ...rest] = tab.page;
  const Lock = /^https:/i.test(tab.url) ? LockIcon : GlobeIcon;
  return (
    <article className="lilos-v3-line-in mx-auto w-full max-w-[680px] px-6 pt-10 pb-20 @min-[720px]:px-8">
      <p className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground/70">
        <Lock className="size-3" />
        {hostOf(tab.url)}
      </p>
      <h1 className="mt-3 font-semibold text-[26px] text-foreground leading-tight tracking-[-0.01em]">
        {head ?? tab.title}
      </h1>
      <div className="mt-6 space-y-2">
        {rest.map((line) => (
          <p
            key={line}
            className="rounded-[10px] border border-[var(--v3-line)] px-4 py-3 text-[14.5px] text-foreground leading-relaxed"
          >
            {line}
          </p>
        ))}
      </div>
    </article>
  );
}

/** Under the address bar on an agent's tab: who drives it, and the way to
   take it over, hand it back, or see the thread behind it. */
export function AgentBanner({
  data,
  tab,
  go,
  act,
}: Pick<V3PageProps, "data" | "go" | "act"> & { tab: V3BrowserTab }) {
  const agent = agentOf(data, tab.by);
  const threadId = tab.threadId;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-[var(--v3-line)] border-b bg-[var(--v3-soft)] px-3 py-2 text-[13.5px]">
      <AgentAvatar data={data} agent={agent} size={20} />
      <p className="flex min-w-0 flex-1 basis-[260px] items-center gap-2 text-muted-foreground">
        <StatusDot status={tabStatus(data, tab)} />
        {tab.takenOver ? (
          <span className="min-w-0 truncate">
            You took this tab over —{" "}
            <b className="font-medium text-foreground">{agent.name}</b> is
            paused
          </span>
        ) : (
          <span className="min-w-0 truncate">
            <b className="font-medium text-foreground">{agent.name}</b> is
            driving{tab.doing ? ` · ${tab.doing}` : ""}
          </span>
        )}
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <Btn small primary onClick={() => act.browserTakeOver(tab.id)}>
          {tab.takenOver ? (
            <Undo2Icon className="size-3.5" />
          ) : (
            <HandIcon className="size-3.5" />
          )}
          {tab.takenOver ? "Hand back" : "Take over"}
        </Btn>
        {threadId && (
          <Btn small onClick={() => go({ page: "thread", id: threadId })}>
            Open thread
          </Btn>
        )}
      </div>
    </div>
  );
}
