import { useCallback, useEffect, useRef, useState } from "react";
import { AddressBar } from "./v3-browser-bar";
import {
  AgentBanner,
  NEW_TAB,
  PageBody,
  resolveInput,
  StartView,
  urlKey,
} from "./v3-browser-bits";
import { TabStrip } from "./v3-browser-tabs";
import type { V3PageProps } from "./v3-types";

/* The LilOS Browser: your everyday browser, shared with agents. It fills
   the main area like a window of its own. Your tabs and the agents' tabs sit
   in one strip; an agent's tab says who drives it and lets you take it over.
   Pages are a calm rendering of a few lines, not a real web view. */

/** The tabs you looked at, in order, with where you are in them. A tab has
   no page history of its own here, so back and forward walk this trail. */
type Trail = { ids: string[]; at: number };

export function V3Browser({ data, go, act }: V3PageProps) {
  const { tabs } = data.browser;
  // The strip reads yours first, then the agents'; so does "the first tab".
  const yours = tabs.filter((t) => t.by === "you");
  const agents = tabs.filter((t) => t.by !== "you");
  const order = [...yours, ...agents];

  const [picked, setPicked] = useState<string>();
  // The empty tab from + / ⌘T, until you give it an address.
  const [blank, setBlank] = useState(false);
  const [trail, setTrail] = useState<Trail>(() => ({
    ids: order[0] ? [order[0].id] : [],
    at: order[0] ? 0 : -1,
  }));
  const [reloads, setReloads] = useState(0);
  const [focusKey, setFocusKey] = useState(0);
  // Bookmarks follow the data; the star only layers your changes on top.
  const [added, setAdded] = useState<{ title: string; url: string }[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);

  const blankShown = blank && (picked === NEW_TAB || order.length === 0);
  const tab = blankShown
    ? undefined
    : (order.find((t) => t.id === picked) ?? order[0]);
  const shownId = blankShown ? NEW_TAB : tab?.id;

  const visit = useCallback((id: string) => {
    setPicked(id);
    setTrail((t) =>
      t.ids[t.at] === id
        ? t
        : { ids: [...t.ids.slice(0, t.at + 1), id], at: t.at + 1 },
    );
  }, []);

  // A tab opened from this page becomes the one on show; tabs an agent
  // opens on its own never pull you away from what you are reading.
  const awaiting = useRef(false);
  const known = useRef(new Set(tabs.map((t) => t.id)));
  useEffect(() => {
    const fresh = tabs.filter((t) => !known.current.has(t.id));
    known.current = new Set(tabs.map((t) => t.id));
    const last = fresh[fresh.length - 1];
    if (!last || !awaiting.current) return;
    awaiting.current = false;
    setBlank(false);
    visit(last.id);
  }, [tabs, visit]);

  const bookmarks = [
    ...data.browser.bookmarks,
    ...added.filter(
      (a) =>
        !data.browser.bookmarks.some((b) => urlKey(b.url) === urlKey(a.url)),
    ),
  ].filter((b) => !removed.includes(urlKey(b.url)));
  const starred =
    !!tab && bookmarks.some((b) => urlKey(b.url) === urlKey(tab.url));
  const recent = [...tabs]
    .reverse()
    .filter((t) => !bookmarks.some((b) => urlKey(b.url) === urlKey(t.url)))
    .slice(0, 5)
    .map((t) => ({ title: t.title, url: t.url }));

  const toggleStar = () => {
    if (!tab) return;
    const key = urlKey(tab.url);
    if (starred) {
      setRemoved((r) => [...r, key]);
      setAdded((a) => a.filter((b) => urlKey(b.url) !== key));
    } else {
      setRemoved((r) => r.filter((k) => k !== key));
      setAdded((a) => [...a, { title: tab.title, url: tab.url }]);
    }
  };

  // Opening an address you already have open switches to it, as in any
  // browser; anything else is a new tab.
  const openUrl = (url: string) => {
    const open = tabs.find((t) => urlKey(t.url) === urlKey(url));
    if (open) {
      setBlank(false);
      visit(open.id);
      return;
    }
    awaiting.current = true;
    act.browserOpen(url);
  };

  const newTab = () => {
    setBlank(true);
    visit(NEW_TAB);
    setFocusKey((k) => k + 1);
  };

  const closeTab = (id: string) => {
    const i = order.findIndex((t) => t.id === id);
    const wasShown = id === shownId;
    if (id === NEW_TAB) setBlank(false);
    else act.browserClose(id);
    if (!wasShown) return;
    // Land on the neighbour, else the blank tab, else the empty window.
    const next = order[i + 1] ?? order[i - 1];
    if (next && next.id !== id) visit(next.id);
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

  // ⌘T / ⌘W / ⌘L, only while this page is on screen. Re-bound every render
  // so the handlers always see the current tabs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "t") newTab();
      else if (k === "w") {
        if (shownId) closeTab(shownId);
      } else if (k === "l") setFocusKey((n) => n + 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <TabStrip
        data={data}
        yours={yours}
        agents={agents}
        blank={blank}
        shownId={shownId}
        onSelect={visit}
        onClose={closeTab}
        onNew={newTab}
      />
      <AddressBar
        url={tab?.url ?? ""}
        hasPage={!!tab}
        starred={starred}
        canBack={near(-1) >= 0}
        canForward={near(1) >= 0}
        reloads={reloads}
        focusKey={focusKey}
        bookmarks={bookmarks}
        recent={recent}
        onBack={() => walk(-1)}
        onForward={() => walk(1)}
        onReload={() => setReloads((n) => n + 1)}
        onToggleStar={toggleStar}
        onSubmit={(text) => openUrl(resolveInput(text))}
        onOpen={openUrl}
        onRemoveBookmark={(url) => setRemoved((r) => [...r, urlKey(url)])}
      />
      {tab && tab.by !== "you" && (
        <AgentBanner data={data} tab={tab} go={go} act={act} />
      )}
      <div className="@container min-h-0 flex-1 overflow-y-auto">
        {tab ? (
          // A new key re-mounts the page, which is what reload does here.
          <PageBody key={`${tab.id}:${reloads}`} tab={tab} />
        ) : (
          <StartView
            empty={!blank}
            links={bookmarks}
            onNew={newTab}
            onOpen={openUrl}
          />
        )}
      </div>
    </div>
  );
}
