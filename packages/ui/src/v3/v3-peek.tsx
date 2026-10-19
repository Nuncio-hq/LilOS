import {
  ArrowLeftIcon,
  ChevronRightIcon,
  Maximize2Icon,
  Minimize2Icon,
  XIcon,
} from "lucide-react";
import { Fragment } from "react";
import { cn } from "../lib/utils";
import { V3AgentPage } from "./v3-agent";
import { V3GoalPage } from "./v3-goals";
import { agentOf, goalOf, projectOf } from "./v3-model";
import { V3ProjectPage } from "./v3-project";
import { V3ThreadPage } from "./v3-thread";
import { V3TicketPage } from "./v3-ticket";
import type { V3Data, V3PageProps, V3RecordRoute } from "./v3-types";

/** A record's name in the trail: short enough to fit four in a row. */
function label(d: V3Data, r: V3RecordRoute) {
  if (r.page === "thread") {
    const t = d.threads.find((x) => x.id === r.id);
    return t
      ? `${agentOf(d, t.agentId).name} · ${t.ticketId ?? "Chat"}`
      : "Thread";
  }
  if (r.page === "agent") return agentOf(d, r.id).name;
  if (r.page === "goal") return goalOf(d, r.id)?.title ?? "Goal";
  if (r.page === "project") return projectOf(d, r.id)?.name ?? "Project";
  return r.id;
}

/* The side peek: whatever you opened, beside the page you opened it from.
   Its header carries the trail (every record you went through, each one a
   step back), so thread → ticket → agent never loses the thread you started
   on. Esc closes it; the page beside it never moved. Widened, it covers the
   page (still mounted underneath) until you narrow or close it. */
export function V3Peek({
  data,
  go,
  act,
  trail,
  full,
  pageName,
  onBack,
  onTrail,
  onFull,
  onClose,
}: V3PageProps & {
  trail: V3RecordRoute[];
  full: boolean;
  /** The page beside the peek, named at the head of the trail. */
  pageName: string;
  onBack: () => void;
  onTrail: (index: number) => void;
  onFull: () => void;
  onClose: () => void;
}) {
  const top = trail[trail.length - 1];
  // Keyed by record: a new record mounts fresh, so it opens at its top.
  const key = `${top.page}:${top.id}`;
  const props = { data, go, act };
  const iconBtn =
    "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground [&_svg]:size-4";
  return (
    <aside
      aria-label="Opened record"
      className={cn(
        "z-20 flex min-w-0 flex-col border-[var(--v3-line)] bg-[var(--v3-main)]",
        full
          ? "absolute inset-0"
          : "w-[min(760px,58%)] min-w-[520px] shrink-0 border-l",
      )}
    >
      <div className="flex h-[46px] shrink-0 items-center gap-1.5 border-[var(--v3-line)] border-b px-2.5 text-[13.5px] text-muted-foreground">
        <button
          type="button"
          onClick={onBack}
          className={iconBtn}
          title="Back one step"
        >
          <ArrowLeftIcon />
        </button>
        <nav
          aria-label="Trail"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
        >
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 truncate hover:text-foreground"
          >
            {pageName}
          </button>
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
          onClick={onFull}
          className={iconBtn}
          title={full ? "Narrow, back beside the page" : "Widen over the page"}
        >
          {full ? <Minimize2Icon /> : <Maximize2Icon />}
        </button>
        <button
          type="button"
          onClick={onClose}
          className={iconBtn}
          title="Close (Esc)"
        >
          <XIcon />
        </button>
      </div>
      <div
        data-v3-scroller
        key={key}
        className="lilos-v3-line-in @container min-h-0 flex-1 overflow-y-auto"
      >
        {top.page === "thread" && <V3ThreadPage {...props} id={top.id} />}
        {top.page === "ticket" && <V3TicketPage {...props} id={top.id} />}
        {top.page === "agent" && <V3AgentPage {...props} id={top.id} />}
        {top.page === "goal" && <V3GoalPage {...props} id={top.id} />}
        {top.page === "project" && <V3ProjectPage {...props} id={top.id} />}
      </div>
    </aside>
  );
}
