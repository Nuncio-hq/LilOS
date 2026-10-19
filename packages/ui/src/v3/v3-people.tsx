import { LayoutListIcon, NetworkIcon, PlusIcon } from "lucide-react";
import { cn } from "../lib/utils";
import {
  Avatar,
  Meter,
  Page,
  RowButton,
  StatusDot,
  StatusPill,
  Tabs,
  Title,
} from "./v3-bits";
import { agentStatus, agentThread, agentTicket } from "./v3-model";
import type { V3Agent, V3Data, V3PageProps } from "./v3-types";

/* People: the same six agents as a table (numbers) or as a tree (who reports
   to whom). Both open the agent's own page. */

/* Beside an open record the table keeps who, status and what they're on;
   model, week and spend come back when the pane is wide enough. */
const GRID =
  "grid grid-cols-[150px_104px_minmax(0,1fr)] @min-[760px]:grid-cols-[170px_104px_minmax(0,1fr)_132px_112px_150px] items-center gap-x-3";
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

function Table({ data, go }: Pick<V3PageProps, "data" | "go">) {
  return (
    <div className="mt-4 text-[14px]">
      <div
        className={cn(
          GRID,
          "border-[var(--v3-line)] border-b pb-[7px] text-[12.5px] text-muted-foreground/70",
        )}
      >
        <span>Agent</span>
        <span>Status</span>
        <span>Working on</span>
        <span className={WIDE}>Model</span>
        <span className={WIDE}>This week</span>
        <span className={WIDE}>Spend</span>
      </div>
      {data.agents.map((a) => {
        const now = nowOf(data, a);
        return (
          <RowButton
            key={a.id}
            opens={{ page: "agent", id: a.id }}
            onClick={() => go({ page: "agent", id: a.id })}
            className={cn(
              GRID,
              "min-h-[50px] border-[var(--v3-line)] border-b py-2",
            )}
          >
            <span className="flex items-center gap-[9px] overflow-hidden">
              <Avatar name={a.name} tone={a.tone} size={24} />
              <span className="min-w-0">
                <span className="block truncate font-medium text-foreground">
                  {a.name}
                </span>
                <span className="block truncate text-[12.5px] text-muted-foreground">
                  {a.role}
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
                <span className="text-muted-foreground/70">
                  {" "}
                  · {now.ticketId}
                </span>
              )}
            </span>
            <span
              className={cn(WIDE, "truncate text-[13px] text-muted-foreground")}
            >
              {a.model}
            </span>
            <span className={cn(WIDE, "text-[13px] text-muted-foreground")}>
              {a.week.done} done
              {a.week.stuck > 0 && (
                <>
                  {" · "}
                  <span className="text-red-600 dark:text-red-300">
                    {a.week.stuck} stuck
                  </span>
                </>
              )}
            </span>
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
          </RowButton>
        );
      })}
    </div>
  );
}

/** A node in the tree: a small bordered box, one click to the agent. */
function Node({
  data,
  a,
  go,
}: { data: V3Data; a: V3Agent } & Pick<V3PageProps, "go">) {
  const now = nowOf(data, a);
  return (
    <button
      type="button"
      onClick={() => go({ page: "agent", id: a.id })}
      className="w-[124px] rounded-lg border border-[var(--v3-line)] bg-background px-2.5 py-2 text-left transition-colors hover:bg-[var(--v3-hover)]"
    >
      <span className="flex items-center gap-2">
        <Avatar name={a.name} tone={a.tone} size={22} />
        <span className="min-w-0">
          <span className="block truncate font-medium text-[13.5px] text-foreground">
            {a.name}
          </span>
          <span className="block truncate text-[12px] text-muted-foreground">
            {a.role}
          </span>
        </span>
      </span>
      <span className="mt-2 flex items-start gap-1.5 text-[12px] text-muted-foreground leading-snug">
        <StatusDot status={agentStatus(data, a.id)} className="mt-[5px]" />
        <span className="line-clamp-2">{now.text}</span>
      </span>
    </button>
  );
}

const LINE = "bg-[var(--v3-line)]";

function OrgChart({ data, go }: Pick<V3PageProps, "data" | "go">) {
  const ceo = data.agents.find((a) => !a.reportsTo) ?? data.agents[0];
  const reports = data.agents.filter((a) => a.reportsTo === ceo.id);

  return (
    <div className="mt-10 flex flex-col items-center overflow-x-auto pb-4">
      <div className="flex w-[120px] items-center gap-2 rounded-lg border border-[var(--v3-line)] bg-[var(--v3-soft)] px-2.5 py-2">
        <Avatar name={data.me} tone="n" size={22} />
        <span className="min-w-0">
          <span className="block truncate font-medium text-[13.5px] text-foreground">
            {data.me}
          </span>
          <span className="block text-[12px] text-muted-foreground">
            Chairman
          </span>
        </span>
      </div>
      <span className={cn("h-6 w-px", LINE)} />
      <Node data={data} a={ceo} go={go} />
      <span className={cn("h-6 w-px", LINE)} />
      <div className="flex">
        {reports.map((a, i) => (
          <div
            key={a.id}
            className="relative flex w-[132px] flex-col items-center pt-6"
          >
            {/* Each child draws its half of the bar above it, plus its own stem. */}
            <span
              className={cn(
                "absolute top-0 h-px",
                LINE,
                i === 0 ? "left-1/2 right-0" : "left-0 right-0",
              )}
            />
            <span className={cn("absolute top-0 h-6 w-px", LINE)} />
            <Node data={data} a={a} go={go} />
          </div>
        ))}
        <div className="relative flex w-[132px] flex-col items-center pt-6">
          <span className={cn("absolute top-0 left-0 h-px w-1/2", LINE)} />
          <span className={cn("absolute top-0 h-6 w-px", LINE)} />
          <button
            type="button"
            onClick={() => go({ page: "hire" })}
            className="flex h-[74px] w-[120px] flex-col items-center justify-center gap-1 rounded-lg border border-[var(--v3-line)] border-dashed text-[13px] text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground"
          >
            <PlusIcon className="size-4" />
            Hire an agent
          </button>
        </div>
      </div>
    </div>
  );
}

export function V3People({
  data,
  go,
  view,
}: V3PageProps & { view: "table" | "org" }) {
  return (
    <Page wide>
      <Title>People</Title>
      <p className="text-[14.5px] text-muted-foreground">
        Six agents, one CEO. You are the Chairman.
      </p>
      <Tabs
        tabs={[
          { id: "table" as const, label: "Table", icon: <LayoutListIcon /> },
          { id: "org" as const, label: "Org chart", icon: <NetworkIcon /> },
        ]}
        value={view}
        onChange={(v) => go({ page: "people", view: v })}
        right={
          <button
            type="button"
            onClick={() => go({ page: "hire" })}
            className="hover:text-foreground"
          >
            + Hire an agent
          </button>
        }
      />
      {view === "table" ? (
        <Table data={data} go={go} />
      ) : (
        <OrgChart data={data} go={go} />
      )}
    </Page>
  );
}
