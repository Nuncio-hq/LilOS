import { SparklesIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../shell/use-theme";
import { makeActions, planRecords } from "./v3-actions";
import { Kbd, OpenRecord } from "./v3-bits";
import { V3ChatNew } from "./v3-chat-new";
import type { ReplyFn } from "./v3-chat-sim";
import { V3Goals } from "./v3-goals";
import { V3Guide } from "./v3-guide";
import { V3Hire } from "./v3-hire";
import { V3Home } from "./v3-home";
import { V3Inbox } from "./v3-inbox";
import { step } from "./v3-nav";
import { V3Needs } from "./v3-needs";
import { V3Palette } from "./v3-palette";
import { V3Peek } from "./v3-peek";
import { V3People } from "./v3-people";
import { V3Settings } from "./v3-settings";
import { V3Sidebar } from "./v3-sidebar";
import { V3Threads } from "./v3-threads";
import type {
  V3Actions,
  V3Data,
  V3Draft,
  V3Nav,
  V3PageRoute,
  V3Route,
} from "./v3-types";
import { V3Work } from "./v3-work";

export type V3ShellProps = {
  initial: V3Data;
  /** Where you are; the app owns it so the URL and Back/Forward work. Updates
     come as functions so two moves in one click (go to Threads, then open
     the new chat) both land. */
  nav: V3Nav;
  onNav: (update: (nav: V3Nav) => V3Nav) => void;
  /** The CEO behind ⌘K: a reply or a draft plan for one line. */
  draft: (text: string, data: V3Data) => V3Draft;
  /** The agent behind a chat: its steps and answer for one message. */
  reply: ReplyFn;
  onToast: (text: string) => void;
};

const PAGE_NAME: Record<V3PageRoute["page"], string> = {
  home: "Home",
  needs: "Needs you",
  inbox: "Inbox",
  work: "Work",
  threads: "Threads",
  goals: "Goals",
  people: "People",
  hire: "Hire an agent",
  guide: "How it works",
  settings: "Settings",
  chat: "New chat",
};

/* The v3 shell owns the company state for the prototype: pages read `data`
   and change it only through `act`, so every screen stays consistent after a
   click (approve on Home and Needs you, Threads and Work all agree). It also
   owns movement: a page on the left, what you opened from it in the side
   peek on the right (see v3-nav.ts). */
export function V3Shell({
  initial,
  nav,
  onNav,
  draft,
  reply,
  onToast,
}: V3ShellProps) {
  const [data, setData] = useState(initial);
  /* Timers in the chat simulator read the latest data, not a stale closure. */
  const dataRef = useRef(data);
  dataRef.current = data;
  const [palette, setPalette] = useState<string | null>(null);
  const [theme, setTheme] = useTheme();
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  /* Two ways to move, one rule each: the page opens a record fresh; the peek
     extends its trail. Changing page always starts at the page's top. */
  const goFromPage = useCallback(
    (r: V3Route) => {
      onNav((n) => step(n, r, "page"));
      if (!("id" in r))
        document.getElementById("v3-main")?.scrollTo({ top: 0 });
    },
    [onNav],
  );
  const goFromPeek = useCallback(
    (r: V3Route) => onNav((n) => step(n, r, "peek")),
    [onNav],
  );
  const closePeek = useCallback(
    () => onNav((n) => ({ ...n, peek: [], full: false })),
    [onNav],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => (p === null ? "" : null));
        return;
      }
      // Esc closes the peek, unless you are typing or the palette owns Esc.
      const typing = (e.target as HTMLElement | null)?.closest(
        "input, textarea",
      );
      if (e.key === "Escape" && palette === null && !typing) closePeek();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [palette, closePeek]);

  const act = useMemo<V3Actions>(
    () =>
      makeActions(
        setData,
        () => dataRef.current,
        reply,
        onToast,
        goFromPage,
        setPalette,
      ),
    [reply, onToast, goFromPage],
  );

  const startPlan = (
    plan: Extract<V3Draft, { kind: "plan" }>,
    text: string,
  ) => {
    setData((d) => planRecords(d, plan, text));
    const started = plan.tickets.filter((t) => !t.after && !t.asksYou).length;
    onToast(
      `${plan.tickets.length} tickets created · ${started} ${started === 1 ? "agent" : "agents"} started`,
    );
    goFromPage({ page: "work", view: "waiting" });
  };

  const page = nav.page;
  const top = nav.peek[nav.peek.length - 1];
  const props = { data, go: goFromPage, act };
  return (
    <OpenRecord.Provider value={top}>
      <div className="lilos-v3 flex h-dvh min-h-0 overflow-hidden bg-[var(--v3-main)] text-[14px] text-foreground">
        <V3Sidebar
          data={data}
          page={page}
          open={top}
          go={goFromPage}
          onSearch={() => setPalette("")}
          dark={dark}
          onTheme={() => setTheme(dark ? "light" : "dark")}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-[46px] shrink-0 items-center justify-between gap-4 pr-3.5 pl-5 text-[14px] text-muted-foreground">
            <div className="flex min-w-0 items-center truncate">
              <button
                type="button"
                onClick={() => goFromPage({ page: "home" })}
                className="hover:text-foreground"
              >
                {data.company}
              </button>
              <span className="mx-1.5 text-muted-foreground/60">/</span>
              <span className="font-medium text-foreground">
                {PAGE_NAME[page.page]}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setPalette("")}
              className="flex h-[30px] w-[280px] items-center gap-2 rounded-lg bg-[var(--v3-hover)] pr-1.5 pl-2.5 text-[13px] text-muted-foreground/80 hover:text-foreground"
            >
              <SparklesIcon className="size-4" />
              Ask the CEO anything…
              <Kbd className="ml-auto">⌘K</Kbd>
            </button>
          </div>
          {/* Page and peek side by side: the page narrows instead of hiding,
            stays mounted (scroll and all), and marks the open row, so
            closing the peek puts you exactly where you were. Widened, the
            peek covers the page without unmounting it. */}
          <div className="relative flex min-h-0 flex-1">
            <main
              id="v3-main"
              data-v3-scroller
              key={JSON.stringify(page)}
              className="lilos-v3-line-in @container min-w-0 flex-1 overflow-y-auto"
            >
              {page.page === "home" && <V3Home {...props} />}
              {page.page === "needs" && <V3Needs {...props} />}
              {page.page === "inbox" && <V3Inbox {...props} />}
              {page.page === "work" && (
                <V3Work {...props} view={page.view ?? "waiting"} />
              )}
              {page.page === "threads" && (
                <V3Threads {...props} view={page.view ?? "live"} />
              )}
              {page.page === "goals" && <V3Goals {...props} />}
              {page.page === "people" && (
                <V3People {...props} view={page.view ?? "table"} />
              )}
              {page.page === "hire" && <V3Hire {...props} />}
              {page.page === "guide" && <V3Guide {...props} />}
              {page.page === "settings" && <V3Settings {...props} />}
              {page.page === "chat" && (
                <V3ChatNew {...props} agentId={page.agentId} />
              )}
            </main>
            {top && (
              <V3Peek
                data={data}
                go={goFromPeek}
                act={act}
                trail={nav.peek}
                full={!!nav.full}
                pageName={PAGE_NAME[page.page]}
                onBack={() =>
                  onNav((n) => ({
                    ...n,
                    peek: n.peek.slice(0, -1),
                    full: n.peek.length > 1 && n.full,
                  }))
                }
                onTrail={(i) =>
                  onNav((n) => ({ ...n, peek: n.peek.slice(0, i + 1) }))
                }
                onFull={() => onNav((n) => ({ ...n, full: !n.full }))}
                onClose={closePeek}
              />
            )}
          </div>
        </div>
        {palette !== null && (
          <V3Palette
            data={data}
            seed={palette}
            draft={draft}
            onStart={startPlan}
            onClose={() => setPalette(null)}
            go={goFromPage}
          />
        )}
      </div>
    </OpenRecord.Provider>
  );
}
