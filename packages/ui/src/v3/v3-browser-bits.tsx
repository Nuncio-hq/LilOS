import { GlobeIcon, HandIcon, LockIcon, Undo2Icon } from "lucide-react";
import { useState } from "react";
import { Btn } from "./v3-bits";
import type { V3Data } from "./v3-data-types";
import { AgentAvatar, StatusDot } from "./v3-marks";
import { agentOf, FORMER_AGENT } from "./v3-model";
import type { V3PageProps } from "./v3-page-types";
import type { V3BrowserTab, V3Status } from "./v3-types";

/* Small pieces of a session's browser: address helpers, the page body, the
   agent banner and the empty state. */

/** Id of the blank tab you opened with +, before it has an address. */
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

/** One key per page, so opening an address you already have switches to it. */
export const urlKey = (url: string) => stripScheme(url).toLowerCase();

/** What an agent's tab is doing, as a status: taking it over pauses the
   agent; otherwise it follows the thread that drives the tab. */
export function tabStatus(data: V3Data, tab: V3BrowserTab): V3Status {
  if (tab.takenOver) return "idle";
  const s = data.threads.find((t) => t.id === tab.threadId)?.status;
  return s && s !== "done" && s !== "planned" ? s : "working";
}

/** A session browser with nothing in it yet, or a blank tab: say so, and
   take an address or a search right here. */
export function SessionStart({
  agentName,
  empty,
  onOpen,
}: {
  /** Who else sees these pages; absent once the agent has left the team. */
  agentName?: string;
  /** No tab at all in this session (else: a blank tab among others). */
  empty: boolean;
  onOpen: (text: string) => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="mx-auto flex w-full max-w-[420px] flex-col items-center px-6 pt-[10vh] pb-16 text-center">
      <GlobeIcon
        className="size-7 text-muted-foreground/60"
        strokeWidth={1.5}
      />
      <p className="mt-3 text-[14px] text-muted-foreground">
        {empty
          ? `No tabs in this thread yet.${agentName ? ` Open a page here and ${agentName} can see it too.` : ""}`
          : `New tab.${agentName ? ` ${agentName} can see pages you open in this thread.` : ""}`}
      </p>
      <form
        className="mt-4 flex h-[34px] w-full items-center rounded-lg bg-[var(--v3-hover)] px-3 focus-within:bg-background focus-within:shadow-[inset_0_0_0_1px_var(--foreground)]"
        onSubmit={(e) => {
          e.preventDefault();
          const v = text.trim();
          if (!v) return;
          onOpen(v);
          setText("");
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search or type an address"
          aria-label="Open a page in this thread"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground/70"
        />
      </form>
    </div>
  );
}

/** A calm rendering of the page's lines (the prototype has no real pages):
   the site on top, the first line as the heading, the rest as cards. The real
   browser paints its pages natively and carries no lines: then there is
   nothing to draw here. */
export function PageBody({ tab }: { tab: V3BrowserTab }) {
  if (!tab.page) return null;
  const [head, ...rest] = tab.page;
  const Lock = /^https:/i.test(tab.url) ? LockIcon : GlobeIcon;
  return (
    <article className="lilos-v3-line-in mx-auto w-full max-w-[680px] px-6 pt-8 pb-16 @min-[720px]:px-8">
      <p className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground/70">
        <Lock className="size-3" />
        {hostOf(tab.url)}
      </p>
      <h1 className="mt-3 font-semibold text-[24px] text-foreground leading-tight tracking-[-0.01em]">
        {head ?? tab.title}
      </h1>
      <div className="mt-5 space-y-2">
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
   take it over or hand it back. The thread behind it is the session you are
   already in. */
export function AgentBanner({
  data,
  tab,
  act,
}: Pick<V3PageProps, "data" | "act"> & { tab: V3BrowserTab }) {
  const agent = agentOf(data, tab.by);
  const name = agent?.name ?? FORMER_AGENT;
  const takeOver = act.browserTakeOver;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-[var(--v3-line)] border-b bg-[var(--v3-soft)] px-3 py-2 text-[13.5px]">
      <AgentAvatar data={data} agent={agent} size={20} />
      <p className="flex min-w-0 flex-1 basis-[200px] items-center gap-2 text-muted-foreground">
        <StatusDot status={tabStatus(data, tab)} />
        {tab.takenOver ? (
          <span className="min-w-0 truncate">
            You took this tab over —{" "}
            <b className="font-medium text-foreground">{name}</b> is paused
          </span>
        ) : (
          <span className="min-w-0 truncate">
            <b className="font-medium text-foreground">{name}</b> is driving
            {tab.doing ? ` · ${tab.doing}` : ""}
          </span>
        )}
      </p>
      {takeOver && (
        <Btn small primary onClick={() => takeOver(tab.id)}>
          {tab.takenOver ? (
            <Undo2Icon className="size-3.5" />
          ) : (
            <HandIcon className="size-3.5" />
          )}
          {tab.takenOver ? "Hand back" : "Take over"}
        </Btn>
      )}
    </div>
  );
}
