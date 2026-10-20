import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AddressBar } from "./v3-browser-bar";
import {
  AgentBanner,
  NEW_TAB,
  PageBody,
  resolveInput,
  SessionStart,
  urlKey,
} from "./v3-browser-bits";
import { TabStrip } from "./v3-browser-tabs";
import { agentOf } from "./v3-model";
import type { V3BrowserTab, V3PageProps, V3Thread } from "./v3-types";

/* A session's own small browser: the tabs its agent drives and the tabs you
   opened in this session, and nothing else. An agent's tab says who drives it
   and lets you take it over. Pages are a calm rendering of a few lines, not a
   real web view. */

/** The tabs you looked at, in order, with where you are in them. A tab has
   no page history of its own here, so back and forward walk this trail. */
type Trail = { ids: string[]; at: number };

/** The tab on show before you pick one: the newest of yours, else the first. */
const startTab = (tabs: V3BrowserTab[]) =>
  [...tabs].reverse().find((t) => t.by === "you") ?? tabs[0];

export function SessionBrowser({
  data,
  act,
  thread,
}: V3PageProps & { thread: V3Thread }) {
  const agent = agentOf(data, thread.agentId);
  const all = data.browser.tabs;
  const tabs = useMemo(
    () => all.filter((t) => t.threadId === thread.id),
    [all, thread.id],
  );

  const [picked, setPicked] = useState<string | undefined>(
    () => startTab(tabs)?.id,
  );
  // The empty tab from +, until you give it an address.
  const [blank, setBlank] = useState(false);
  const [trail, setTrail] = useState<Trail>(() => {
    const first = startTab(tabs);
    return { ids: first ? [first.id] : [], at: first ? 0 : -1 };
  });
  const [reloads, setReloads] = useState(0);
  const [focusKey, setFocusKey] = useState(0);

  const blankShown = blank && (picked === NEW_TAB || tabs.length === 0);
  const tab = blankShown
    ? undefined
    : (tabs.find((t) => t.id === picked) ?? startTab(tabs));
  const shownId = blankShown ? NEW_TAB : tab?.id;

  const visit = useCallback((id: string) => {
    setPicked(id);
    setTrail((t) =>
      t.ids[t.at] === id
        ? t
        : { ids: [...t.ids.slice(0, t.at + 1), id], at: t.at + 1 },
    );
  }, []);

  // A tab you open in this session (from here or from Preview, a PR…)
  // becomes the one on show; tabs the agent opens on its own never pull you
  // away from what you are reading.
  const known = useRef(new Set(tabs.map((t) => t.id)));
  useEffect(() => {
    const fresh = tabs.filter((t) => !known.current.has(t.id));
    known.current = new Set(tabs.map((t) => t.id));
    const mine = fresh.filter((t) => t.by === "you").at(-1);
    if (!mine) return;
    setBlank(false);
    visit(mine.id);
  }, [tabs, visit]);

  // Opening an address this session already has open switches to it, as in
  // any browser; anything else is a new tab.
  const openUrl = (url: string) => {
    const open = tabs.find((t) => urlKey(t.url) === urlKey(url));
    if (open) {
      setBlank(false);
      visit(open.id);
      return;
    }
    act.browserOpen(url, thread.id);
  };

  const newTab = () => {
    setBlank(true);
    visit(NEW_TAB);
    setFocusKey((k) => k + 1);
  };

  const closeTab = (id: string) => {
    const i = tabs.findIndex((t) => t.id === id);
    const wasShown = id === shownId;
    if (id === NEW_TAB) setBlank(false);
    else act.browserClose(id);
    if (!wasShown) return;
    // Land on the neighbour, else the blank tab, else the empty browser.
    const next = id === NEW_TAB ? tabs.at(-1) : (tabs[i + 1] ?? tabs[i - 1]);
    if (next) visit(next.id);
    else if (id !== NEW_TAB && blank) visit(NEW_TAB);
    else setPicked(undefined);
  };

  const alive = (id: string) =>
    id === NEW_TAB ? blank : tabs.some((t) => t.id === id);
  /** The nearest tab on the trail in a direction that is still open. */
  const near = (dir: 1 | -1) => {
    for (let j = trail.at + dir; j >= 0 && j < trail.ids.length; j += dir) {
      const id = trail.ids[j];
      if (id !== shownId && alive(id)) return j;
    }
    return -1;
  };
  const walk = (dir: 1 | -1) => {
    const j = near(dir);
    if (j < 0) return;
    setPicked(trail.ids[j]);
    setTrail({ ...trail, at: j });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <TabStrip
        data={data}
        tabs={tabs}
        blank={blank}
        shownId={shownId}
        onSelect={visit}
        onClose={closeTab}
        onNew={newTab}
      />
      <AddressBar
        url={tab?.url ?? ""}
        hasPage={!!tab}
        canBack={near(-1) >= 0}
        canForward={near(1) >= 0}
        reloads={reloads}
        focusKey={focusKey}
        onBack={() => walk(-1)}
        onForward={() => walk(1)}
        onReload={() => setReloads((n) => n + 1)}
        onSubmit={(text) => openUrl(resolveInput(text))}
      />
      {tab && tab.by !== "you" && (
        <AgentBanner data={data} tab={tab} act={act} />
      )}
      <div className="@container min-h-0 flex-1 overflow-y-auto">
        {tab ? (
          // A new key re-mounts the page, which is what reload does here.
          <PageBody key={`${tab.id}:${reloads}`} tab={tab} />
        ) : (
          <SessionStart
            agentName={agent.name}
            empty={tabs.length === 0}
            onOpen={(text) => openUrl(resolveInput(text))}
          />
        )}
      </div>
    </div>
  );
}
