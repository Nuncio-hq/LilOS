import { SparklesIcon } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTheme } from "../shell/use-theme";
import { makeActions, planRecords } from "./v3-actions";
import { V3AgentPage } from "./v3-agent";
import { Kbd } from "./v3-bits";
import { V3ChatNew } from "./v3-chat-new";
import type { ReplyFn } from "./v3-chat-sim";
import { V3GoalPage, V3Goals } from "./v3-goals";
import { V3Guide } from "./v3-guide";
import { V3Hire } from "./v3-hire";
import { V3Home } from "./v3-home";
import { V3Inbox } from "./v3-inbox";
import { agentOf, goalOf, projectOf } from "./v3-model";
import { V3Needs } from "./v3-needs";
import { V3Palette } from "./v3-palette";
import { V3People } from "./v3-people";
import { V3ProjectPage } from "./v3-project";
import { V3Sidebar } from "./v3-sidebar";
import { V3ThreadPage } from "./v3-thread";
import { V3Threads } from "./v3-threads";
import { V3TicketPage } from "./v3-ticket";
import type { V3Actions, V3Data, V3Draft, V3Route } from "./v3-types";
import { V3Work } from "./v3-work";

export type V3ShellProps = {
  initial: V3Data;
  /** The page on screen; the app owns it so the URL and Back/Forward work. */
  route: V3Route;
  onRoute: (route: V3Route) => void;
  /** The CEO behind ⌘K: a reply or a draft plan for one line. */
  draft: (text: string, data: V3Data) => V3Draft;
  /** The agent behind a chat: its steps and answer for one message. */
  reply: ReplyFn;
  onToast: (text: string) => void;
};

/* The v3 shell owns the company state for the prototype: pages read `data`
   and change it only through `act`, so every screen stays consistent after a
   click (approve on Home and Needs you, Threads and Work all agree). */
export function V3Shell({
  initial,
  route,
  onRoute,
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

  const go = useCallback(
    (r: V3Route) => {
      onRoute(r);
      document.getElementById("v3-main")?.scrollTo({ top: 0 });
    },
    [onRoute],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => (p === null ? "" : null));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const act = useMemo<V3Actions>(
    () =>
      makeActions(
        setData,
        () => dataRef.current,
        reply,
        onToast,
        go,
        setPalette,
      ),
    [reply, onToast, go],
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
    go({ page: "work", view: "waiting" });
  };

  const props = { data, go, act };
  return (
    <div className="lilos-v3 flex h-dvh min-h-0 overflow-hidden bg-[var(--v3-main)] text-[14px] text-foreground">
      <V3Sidebar
        data={data}
        route={route}
        go={go}
        onSearch={() => setPalette("")}
        dark={dark}
        onTheme={() => setTheme(dark ? "light" : "dark")}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[46px] shrink-0 items-center justify-between gap-4 pr-3.5 pl-5 text-[14px] text-muted-foreground">
          <Crumbs data={data} route={route} go={go} />
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
        <main
          id="v3-main"
          key={JSON.stringify(route)}
          className="lilos-v3-line-in min-h-0 flex-1 overflow-y-auto"
        >
          {route.page === "home" && <V3Home {...props} />}
          {route.page === "needs" && <V3Needs {...props} />}
          {route.page === "inbox" && <V3Inbox {...props} />}
          {route.page === "work" && (
            <V3Work {...props} view={route.view ?? "waiting"} />
          )}
          {route.page === "ticket" && <V3TicketPage {...props} id={route.id} />}
          {route.page === "threads" && (
            <V3Threads {...props} view={route.view ?? "live"} />
          )}
          {route.page === "thread" && <V3ThreadPage {...props} id={route.id} />}
          {route.page === "goals" && <V3Goals {...props} />}
          {route.page === "goal" && <V3GoalPage {...props} id={route.id} />}
          {route.page === "project" && (
            <V3ProjectPage {...props} id={route.id} />
          )}
          {route.page === "people" && (
            <V3People {...props} view={route.view ?? "table"} />
          )}
          {route.page === "agent" && <V3AgentPage {...props} id={route.id} />}
          {route.page === "hire" && <V3Hire {...props} />}
          {route.page === "guide" && <V3Guide {...props} />}
          {route.page === "chat" && (
            <V3ChatNew {...props} agentId={route.agentId} />
          )}
        </main>
      </div>
      {palette !== null && (
        <V3Palette
          data={data}
          seed={palette}
          draft={draft}
          onStart={startPlan}
          onClose={() => setPalette(null)}
          go={go}
        />
      )}
    </div>
  );
}

/* Breadcrumb: company / database / record, each part clickable. */
function Crumbs({
  data,
  route,
  go,
}: {
  data: V3Data;
  route: V3Route;
  go: (r: V3Route) => void;
}) {
  const parts: { label: string; to?: V3Route }[] = [
    { label: data.company, to: { page: "home" } },
  ];
  const t = route.page;
  if (t === "home") parts.push({ label: "Home" });
  if (t === "needs") parts.push({ label: "Needs you" });
  if (t === "inbox") parts.push({ label: "Inbox" });
  if (t === "work") parts.push({ label: "Work" });
  if (t === "ticket")
    parts.push({ label: "Work", to: { page: "work" } }, { label: route.id });
  if (t === "threads") parts.push({ label: "Threads" });
  if (t === "chat")
    parts.push(
      { label: "Threads", to: { page: "threads" } },
      { label: "New chat" },
    );
  if (t === "thread") {
    const th = data.threads.find((x) => x.id === route.id);
    parts.push(
      { label: "Threads", to: { page: "threads" } },
      {
        label: th
          ? `${agentOf(data, th.agentId).name} · ${th.ticketId ?? "Chat"}`
          : route.id,
      },
    );
  }
  if (t === "goals") parts.push({ label: "Goals" });
  if (t === "goal")
    parts.push(
      { label: "Goals", to: { page: "goals" } },
      { label: goalOf(data, route.id)?.title ?? route.id },
    );
  if (t === "project")
    parts.push(
      { label: "Projects" },
      { label: projectOf(data, route.id)?.name ?? route.id },
    );
  if (t === "people") parts.push({ label: "People" });
  if (t === "agent")
    parts.push(
      { label: "People", to: { page: "people" } },
      { label: agentOf(data, route.id).name },
    );
  if (t === "hire")
    parts.push(
      { label: "People", to: { page: "people" } },
      { label: "Hire an agent" },
    );
  if (t === "guide") parts.push({ label: "How it works" });
  return (
    <div className="flex min-w-0 items-center truncate">
      {parts.map((p, i) => (
        <Fragment key={`${p.label}-${i}`}>
          {i > 0 && <span className="mx-1.5 text-muted-foreground/60">/</span>}
          {p.to && i < parts.length - 1 ? (
            <button
              type="button"
              onClick={() => p.to && go(p.to)}
              className="hover:text-foreground"
            >
              {p.label}
            </button>
          ) : (
            <span
              className={
                i === parts.length - 1 ? "font-medium text-foreground" : ""
              }
            >
              {p.label}
            </span>
          )}
        </Fragment>
      ))}
    </div>
  );
}
