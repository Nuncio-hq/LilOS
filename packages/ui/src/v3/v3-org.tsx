import { PlusIcon } from "lucide-react";
import { cn } from "../lib/utils";
import type { V3Data } from "./v3-data-types";
import { AgentAvatar, Avatar, CeoMark, StatusDot } from "./v3-marks";
import { agentStatus, agentThread, agentTicket, reportsOf } from "./v3-model";
import type { V3PageProps } from "./v3-page-types";
import type { V3Agent } from "./v3-types";

/* Who reports to whom (D-#775). `reportsTo` names an employee; absent, or
   an id that is gone, means the owner — the profile name on `data.me`,
   never a hardcoded one, and not the CEO position. The crown is only a
   mark. A cycle is rejected by the relay; the walk still stops at a repeat
   so a bad row cannot hang the page, and anyone the walk never reaches
   is drawn under the owner rather than dropped. */

const LINE = "bg-[var(--v3-line)]";

function nowText(data: V3Data, a: V3Agent): string {
  if (agentStatus(data, a.id) === "idle") return a.next ?? "Nothing assigned";
  return (
    agentThread(data, a.id)?.title ?? agentTicket(data, a.id)?.title ?? "—"
  );
}

/** Everyone the walk from the owner reaches. */
function reached(agents: readonly V3Agent[]): Set<string> {
  const seen = new Set<string>();
  const walk = (managerId?: string) => {
    for (const a of reportsOf(agents, managerId)) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      walk(a.id);
    }
  };
  walk(undefined);
  return seen;
}

/** One person per group the owner-walk never reaches (a cycle the relay
    rejected, or a row left over). The rest of that group hangs under them. */
function entryPoints(agents: readonly V3Agent[]): V3Agent[] {
  const seen = reached(agents);
  const extra: V3Agent[] = [];
  for (const a of agents) {
    if (seen.has(a.id)) continue;
    extra.push(a);
    const stack = [a.id];
    seen.add(a.id);
    while (stack.length) {
      const id = stack.pop() as string;
      for (const kid of reportsOf(agents, id)) {
        if (seen.has(kid.id)) continue;
        seen.add(kid.id);
        stack.push(kid.id);
      }
    }
  }
  return extra;
}

function Owner({ data }: { data: V3Data }) {
  return (
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
  );
}

function Node({
  data,
  a,
  boss,
  go,
}: { data: V3Data; a: V3Agent; boss: string } & Pick<V3PageProps, "go">) {
  return (
    <button
      type="button"
      data-reports-to={boss}
      onClick={() => go({ page: "agent", id: a.id })}
      className="w-[132px] rounded-lg border border-[var(--v3-line)] bg-background px-2.5 py-2 text-left transition-colors hover:bg-[var(--v3-hover)]"
    >
      <span className="flex items-center gap-2">
        <AgentAvatar data={data} agent={a} size={22} />
        <span className="min-w-0">
          <span className="flex items-center gap-1">
            <span className="truncate font-medium text-[13.5px] text-foreground">
              {a.name}
            </span>
            {a.id === data.ceoId && <CeoMark />}
          </span>
          <span className="block truncate text-[12px] text-muted-foreground">
            {a.role}
          </span>
        </span>
      </span>
      <span className="mt-2 flex items-start gap-1.5 text-[12px] text-muted-foreground leading-snug">
        <StatusDot status={agentStatus(data, a.id)} className="mt-[5px]" />
        <span className="line-clamp-2">{nowText(data, a)}</span>
      </span>
    </button>
  );
}

/** The bar above one sibling: from its centre to the next sibling's, so a
    wider subtree still meets its neighbours at the column edge. */
function Bar({ i, slots }: { i: number; slots: number }) {
  if (slots <= 1) return null;
  return (
    <span
      className={cn(
        "absolute top-0 h-px",
        LINE,
        i === 0
          ? "left-1/2 right-0"
          : i === slots - 1
            ? "left-0 w-1/2"
            : "left-0 right-0",
      )}
    />
  );
}

function Row({
  data,
  go,
  act,
  parentId,
  hire,
  seen,
  extra,
}: Pick<V3PageProps, "data" | "go" | "act"> & {
  parentId?: string;
  hire: boolean;
  seen: Set<string>;
  extra?: V3Agent[];
}) {
  const kids = [
    ...reportsOf(data.agents, parentId).filter((a) => !seen.has(a.id)),
    ...(extra ?? []),
  ];
  const showHire = hire && !!act.hire;
  const slots = kids.length + (showHire ? 1 : 0);
  if (slots === 0) return null;
  const boss = parentId ?? "owner";
  /* Hire sits where a new person lands: under the CEO when that position
     exists, otherwise under the owner. */
  const hireUnder = data.agents.find((a) => a.id === data.ceoId)?.id;
  return (
    <>
      <span className={cn("h-6 w-px", LINE)} />
      <div className="flex">
        {kids.map((a, i) => {
          const next = new Set(seen);
          next.add(a.id);
          return (
            <div
              key={a.id}
              className="relative flex w-max min-w-[140px] flex-col items-center pt-6"
            >
              <Bar i={i} slots={slots} />
              <span className={cn("absolute top-0 h-6 w-px", LINE)} />
              <Node data={data} a={a} boss={boss} go={go} />
              <Row
                data={data}
                go={go}
                act={act}
                parentId={a.id}
                hire={a.id === hireUnder}
                seen={next}
              />
            </div>
          );
        })}
        {showHire && (
          <div className="relative flex w-max min-w-[140px] flex-col items-center pt-6">
            <Bar i={kids.length} slots={slots} />
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
        )}
      </div>
    </>
  );
}

export function OrgChart({
  data,
  go,
  act,
}: Pick<V3PageProps, "data" | "go" | "act">) {
  const ceo = data.agents.some((a) => a.id === data.ceoId);
  return (
    <div className="mt-10 overflow-x-auto pb-4">
      <div className="mx-auto flex w-max flex-col items-center">
        <Owner data={data} />
        <Row
          data={data}
          go={go}
          act={act}
          hire={!ceo}
          seen={new Set()}
          extra={entryPoints(data.agents)}
        />
      </div>
    </div>
  );
}
