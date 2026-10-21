import {
  ArrowLeftIcon,
  ChevronRightIcon,
  Maximize2Icon,
  Minimize2Icon,
  XIcon,
} from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { V3AgentPage } from "./v3-agent";
import type { V3Data } from "./v3-data-types";
import { V3DraftChat } from "./v3-draft-chat";
import { V3GoalPage } from "./v3-goals";
import {
  agentNameOf,
  agentOf,
  defaultAgent,
  goalOf,
  projectOf,
  threadTag,
} from "./v3-model";
import type { V3PageProps, V3RecordRoute } from "./v3-page-types";
import { V3ProjectPage } from "./v3-project";
import { V3TicketPage } from "./v3-ticket";
import { toolbarBtn } from "./v3-topbar";

/** A record's name in the trail: short enough to fit four in a row. */
function label(d: V3Data, r: V3RecordRoute) {
  if (r.page === "thread") {
    const t =
      d.threads.find((x) => x.id === r.id) ??
      d.archivedThreads?.find((x) => x.id === r.id);
    return t ? `${agentNameOf(d, t.agentId)} · ${threadTag(d, t)}` : "Thread";
  }
  if (r.page === "agent") return agentNameOf(d, r.id);
  if (r.page === "newchat") {
    // The draft talks to the default agent when the id names nobody.
    const to = agentOf(d, r.id) ?? defaultAgent(d);
    return to ? `New chat · ${to.name}` : "New chat";
  }
  if (r.page === "goal") return goalOf(d, r.id)?.title ?? "Goal";
  if (r.page === "project") return projectOf(d, r.id)?.name ?? "Project";
  return r.id;
}

/* The side peek: whatever you opened, beside the page you opened it from.
   Its toolbar segment carries the trail (every record you went through, each
   one a step back), so thread → ticket → agent never loses the thread you
   started on. Esc closes it; the page beside it never moved. Widened, it
   covers the page (still mounted underneath) until you narrow or close it.
   It is one <aside> that starts at the window's top: its first row IS the
   toolbar row (D-#232, #797) — no header row of its own below one — and it
   takes the shell's rows as a subgrid, so a notice between the toolbar and
   the page (v3-banner) stays visible above it, widened or not. */
export function V3Peek({
  data,
  go,
  act,
  trail,
  full,
  pageName,
  lead,
  onBack,
  onTrail,
  onFull,
  onClose,
  renderThread,
}: V3PageProps & {
  trail: V3RecordRoute[];
  full: boolean;
  /** The page beside the peek, named at the head of the trail. */
  pageName: string;
  /** Widened over a hidden sidebar, this is the leftmost segment of the
      toolbar: it leads with what the sidebar left there (toggle, Search). */
  lead?: ReactNode;
  onBack: () => void;
  onTrail: (index: number) => void;
  /** Widen over the page (a session) or narrow back beside it. */
  onFull: (full: boolean) => void;
  onClose: () => void;
  /** The app's thread view for a thread record (see V3Shell). */
  renderThread: (props: V3PageProps & { id: string }) => ReactNode;
}) {
  const top = trail[trail.length - 1];
  // Keyed by record: a new record mounts fresh, so it opens at its top.
  const key = `${top.page}:${top.id}`;
  const props = { data, go, act };
  return (
    <aside
      aria-label="Opened record"
      /* Widened, this covers the page under it. Needs you keys read the
         attribute so they do nothing while the page is covered. */
      data-covers={full ? "" : undefined}
      className={cn(
        "z-20 row-span-3 row-start-1 grid min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-subgrid border-[var(--v3-line)] bg-[var(--v3-main)]",
        full ? "col-span-full col-start-1" : "col-start-2 border-l",
      )}
    >
      <div
        data-toolbar
        data-toolbar-lead={lead ? "" : undefined}
        className={cn(
          "lilos-drag row-start-1 flex items-center gap-1.5 pr-2.5 text-[13.5px] text-muted-foreground",
          lead ? "pl-3.5" : "pl-2.5",
        )}
      >
        {lead}
        <button
          type="button"
          onClick={onBack}
          className={toolbarBtn}
          title="Back one step"
          aria-label="Back one step"
        >
          <ArrowLeftIcon />
        </button>
        <nav
          aria-label="Trail"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
        >
          {/* Where you came from, as context: the ✕ is the one way to close. */}
          <span className="shrink-0 truncate">{pageName}</span>
          {trail.map((r, i) => (
            <Fragment key={`${r.page}:${r.id}`}>
              <ChevronRightIcon className="size-3.5 shrink-0 opacity-50" />
              {i === trail.length - 1 ? (
                <span className="min-w-0 truncate font-medium text-foreground">
                  {label(data, r)}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onTrail(i)}
                  className="min-w-0 max-w-[180px] shrink truncate hover:text-foreground"
                >
                  {label(data, r)}
                </button>
              )}
            </Fragment>
          ))}
        </nav>
        <button
          type="button"
          onClick={() => onFull(!full)}
          className={toolbarBtn}
          title={full ? "Narrow, back beside the page" : "Widen over the page"}
          aria-label={
            full ? "Narrow, back beside the page" : "Widen over the page"
          }
        >
          {full ? <Minimize2Icon /> : <Maximize2Icon />}
        </button>
        <button
          type="button"
          onClick={onClose}
          className={toolbarBtn}
          title="Close (Esc)"
          aria-label="Close"
        >
          <XIcon />
        </button>
      </div>
      <div
        data-v3-scroller
        key={key}
        className="lilos-v3-line-in @container row-start-3 min-h-0 overflow-y-auto"
      >
        {top.page === "thread" && renderThread({ ...props, id: top.id })}
        {top.page === "newchat" && <V3DraftChat {...props} id={top.id} />}
        {top.page === "ticket" && <V3TicketPage {...props} id={top.id} />}
        {top.page === "agent" && <V3AgentPage {...props} id={top.id} />}
        {top.page === "goal" && <V3GoalPage {...props} id={top.id} />}
        {top.page === "project" && <V3ProjectPage {...props} id={top.id} />}
      </div>
    </aside>
  );
}
