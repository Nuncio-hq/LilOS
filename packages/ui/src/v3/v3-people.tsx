import { LayoutListIcon, NetworkIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { Meter, Page, Tabs, Title } from "./v3-bits";
import type { V3Data } from "./v3-data-types";
import { AgentAvatar, CeoMark, INK, StatusPill } from "./v3-marks";
import { agentStatus, agentThread, agentTicket } from "./v3-model";
import { RowButton } from "./v3-open-record";
import { OrgChart } from "./v3-org";
import type { V3PageProps } from "./v3-page-types";
import type { V3Agent } from "./v3-types";

/* People: every agent as a table (numbers) or as a tree (who reports to
   whom). LilOS agents and outside workers are listed apart: an outside worker
   is a bot reached through a connector, so it has no model or spend. Both
   views open the agent's own page. */

/* Beside an open record the table keeps who, status and what they're on;
   model, week and spend come back when the pane is wide enough. Week and
   spend are columns only when the app can tell them for someone, and the
   grid follows the columns shown. */
type Cols = { week: boolean; spend: boolean; grid: string };
const GRIDS: Record<`${boolean}-${boolean}`, string> = {
  "true-true":
    "grid grid-cols-[150px_104px_minmax(0,1fr)] @min-[760px]:grid-cols-[170px_104px_minmax(0,1fr)_132px_112px_150px] items-center gap-x-3",
  "true-false":
    "grid grid-cols-[150px_104px_minmax(0,1fr)] @min-[760px]:grid-cols-[170px_104px_minmax(0,1fr)_132px_112px] items-center gap-x-3",
  "false-true":
    "grid grid-cols-[150px_104px_minmax(0,1fr)] @min-[760px]:grid-cols-[170px_104px_minmax(0,1fr)_132px_150px] items-center gap-x-3",
  "false-false":
    "grid grid-cols-[150px_104px_minmax(0,1fr)] @min-[760px]:grid-cols-[170px_104px_minmax(0,1fr)_132px] items-center gap-x-3",
};
const WIDE = "hidden @min-[760px]:block";

/** What an agent is on right now, as a title plus the ticket it belongs to. */
function nowOf(d: V3Data, a: V3Agent) {
  const status = agentStatus(d, a.id);
  if (status === "idle")
    return { text: a.next ?? "Nothing assigned", ticketId: undefined };
  const thread = agentThread(d, a.id);
  const ticket = agentTicket(d, a.id);
  return {
    text: thread?.title ?? ticket?.title ?? "—",
    ticketId: thread?.ticketId ?? ticket?.id,
  };
}

/** The connector an outside worker is reached through. */
const viaOf = (d: V3Data, a: V3Agent) =>
  a.kind === "outside" ? d.connectors.find((c) => c.id === a.via) : undefined;

/** Column labels; an outside worker's table swaps Model for the connector
   and has no spend. */
function Head({ outside, cols }: { outside?: boolean; cols: Cols }) {
  return (
    <div
      className={cn(
        cols.grid,
        "border-[var(--v3-line)] border-b pb-[7px] text-[12.5px] text-muted-foreground/70",
      )}
    >
      <span>{outside ? "Worker" : "Agent"}</span>
      <span>Status</span>
      <span>Working on</span>
      <span className={WIDE}>{outside ? "Reached through" : "Model"}</span>
      {cols.week && <span className={WIDE}>This week</span>}
      {cols.spend && <span className={WIDE}>{outside ? "" : "Spend"}</span>}
    </div>
  );
}

function PersonRow({
  data,
  a,
  go,
  cols,
}: { data: V3Data; a: V3Agent; cols: Cols } & Pick<V3PageProps, "go">) {
  const now = nowOf(data, a);
  const via = viaOf(data, a);
  return (
    <RowButton
      opens={{ page: "agent", id: a.id }}
      onClick={() => go({ page: "agent", id: a.id })}
      className={cn(
        cols.grid,
        "min-h-[50px] border-[var(--v3-line)] border-b py-2",
      )}
    >
      <span className="flex items-center gap-[9px] overflow-hidden">
        <AgentAvatar data={data} agent={a} size={24} />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-medium text-foreground">
              {a.name}
            </span>
            {a.id === data.ceoId && <CeoMark />}
          </span>
          <span className="block truncate text-[12.5px] text-muted-foreground">
            {a.role}
            {via && (
              <span className="@min-[760px]:hidden"> · via {via.label}</span>
            )}
          </span>
        </span>
      </span>
      <span>
        <StatusPill status={agentStatus(data, a.id)} />
      </span>
      <span
        className={cn(
          "truncate",
          now.ticketId ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {now.text}
        {now.ticketId && (
          <span className="text-muted-foreground/70"> · {now.ticketId}</span>
        )}
      </span>
      <span
        className={cn(
          WIDE,
          "truncate text-[13px]",
          a.kind === "outside"
            ? "text-muted-foreground/70"
            : "text-muted-foreground",
        )}
      >
        {a.kind === "outside" ? (via ? `via ${via.label}` : "—") : a.model}
      </span>
      {cols.week && (
        <span className={cn(WIDE, "text-[13px] text-muted-foreground")}>
          <WeekBits a={a} />
        </span>
      )}
      {cols.spend &&
        (a.kind === "outside" || !a.spend ? (
          <span className={WIDE} />
        ) : (
          <span className="hidden items-center gap-2 @min-[760px]:flex">
            <Meter
              value={(a.spend.used / a.spend.cap) * 100}
              className="w-12"
            />
            <span className="whitespace-nowrap text-[12.5px] text-muted-foreground">
              ${a.spend.used.toFixed(a.spend.used < 100 ? 2 : 0)} of $
              {a.spend.cap}
            </span>
          </span>
        ))}
    </RowButton>
  );
}

function Table({
  data,
  go,
  canConnect,
}: Pick<V3PageProps, "data" | "go"> & {
  /** Connectors can be added here, so an empty Outside workers list has a
     next step; otherwise an empty section is left out. */
  canConnect: boolean;
}) {
  const agents = data.agents.filter((a) => a.kind !== "outside");
  const workers = data.agents.filter((a) => a.kind === "outside");
  const week = data.agents.some((a) => a.week || a.weekThreads);
  const spend = data.agents.some((a) => a.kind !== "outside" && a.spend);
  const cols: Cols = { week, spend, grid: GRIDS[`${week}-${spend}`] };
  const hasCeo = data.agents.some((a) => a.id === data.ceoId);
  return (
    <div className="mt-4 text-[14px]">
      <h3 className="mb-1.5 flex items-baseline gap-2 font-semibold text-[15px] text-foreground">
        Agents
        <small className="font-normal text-[13px] text-muted-foreground/70">
          {agents.length}
        </small>
      </h3>
      <Head cols={cols} />
      {agents.map((a) => (
        <PersonRow key={a.id} data={data} a={a} go={go} cols={cols} />
      ))}

      {(workers.length > 0 || canConnect) && (
        <>
          <h3 className="mt-10 mb-1.5 flex flex-wrap items-baseline gap-x-2 font-semibold text-[15px] text-foreground">
            Outside workers
            <small className="font-normal text-[13px] text-muted-foreground/70">
              {workers.length}
            </small>
            <span className="font-normal text-[13px] text-muted-foreground">
              {hasCeo
                ? "Always-on bots the CEO reaches through a connector."
                : "Always-on bots reached through a connector."}
            </span>
          </h3>
          {workers.length === 0 ? (
            <p className="border-[var(--v3-line)] border-t py-3 text-muted-foreground">
              None yet. Add a connector in Settings.
            </p>
          ) : (
            <>
              <Head outside cols={cols} />
              {workers.map((a) => (
                <PersonRow key={a.id} data={data} a={a} go={go} cols={cols} />
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** This week's threads when the app counted them; otherwise the prototype's
    ticket week. Colour is only the status word (failed, stuck). */
function WeekBits({ a }: { a: V3Agent }) {
  const w = a.weekThreads;
  if (w) {
    return (
      <>
        {w.finished} finished
        {w.failed > 0 && (
          <>
            {" · "}
            <span className={INK.failed}>{w.failed} failed</span>
          </>
        )}
        {w.stuck > 0 && (
          <>
            {" · "}
            <span className={INK.stuck}>{w.stuck} stuck</span>
          </>
        )}
      </>
    );
  }
  if (!a.week) return null;
  return (
    <>
      {a.week.done} done
      {a.week.stuck > 0 && (
        <>
          {" · "}
          <span className={INK.stuck}>{a.week.stuck} stuck</span>
        </>
      )}
    </>
  );
}

export function V3People({
  data,
  go,
  act,
  view,
}: V3PageProps & { view: "table" | "org" }) {
  const workers = data.agents.filter((a) => a.kind === "outside").length;
  const agents = data.agents.length - workers;
  const ceo = data.agents.find((a) => a.id === data.ceoId);
  return (
    <Page wide>
      <Title>People</Title>
      <p className="text-[14.5px] text-muted-foreground">
        {agents} {agents === 1 ? "agent" : "agents"}
        {workers > 0 &&
          ` and ${workers} outside ${workers === 1 ? "worker" : "workers"}`}
        . {ceo && `${ceo.name} holds the CEO position. `}You are the Chairman.
      </p>
      <Tabs
        tabs={[
          { id: "table" as const, label: "Table", icon: <LayoutListIcon /> },
          { id: "org" as const, label: "Org chart", icon: <NetworkIcon /> },
        ]}
        value={view}
        onChange={(v) => go({ page: "people", view: v })}
        /* The org chart has its own "Hire an agent" tile; the table has none,
           so only the table carries the link — one entry per view. */
        right={
          act.hire &&
          view === "table" && (
            <button
              type="button"
              onClick={() => go({ page: "hire" })}
              className="hover:text-foreground"
            >
              + Hire an agent
            </button>
          )
        }
      />
      {view === "table" ? (
        <Table data={data} go={go} canConnect={!!act.addConnector} />
      ) : (
        <OrgChart data={data} go={go} act={act} />
      )}
    </Page>
  );
}
