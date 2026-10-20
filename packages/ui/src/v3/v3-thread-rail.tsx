import { CheckIcon, WorkflowIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { Diff, Meter, span } from "./v3-bits";
import type { V3Data } from "./v3-data-types";
import { AgentAvatar, ProjectMark } from "./v3-marks";
import { FORMER_AGENT } from "./v3-model";
import type { V3PageProps } from "./v3-page-types";
import { viaOf } from "./v3-rows";
import type { V3Agent, V3Project, V3Thread } from "./v3-types";

/* A thread's Details, the last tab of its work panel: where it runs, the
   plan, what it changed. Full-width rows in a panel of its own. */

function Head({ children, count }: { children: ReactNode; count?: string }) {
  return (
    <div className="mt-6 mb-2 flex justify-between font-medium text-[12px] text-muted-foreground/70 first:mt-0">
      {children}
      {count && <span className="font-normal">{count}</span>}
    </div>
  );
}

function Kv({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[32px] items-center justify-between gap-3 text-[13px]">
      <span className="text-muted-foreground">{k}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-right">
        {children}
      </span>
    </div>
  );
}

const link = "text-sky-700 hover:underline dark:text-sky-300";

function PlanDot({ state }: { state: "done" | "current" | "todo" }) {
  if (state === "done") {
    return (
      <span className="grid size-[15px] shrink-0 place-items-center rounded-full bg-foreground text-background">
        <CheckIcon className="size-[10px]" strokeWidth={3} />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "grid size-[15px] shrink-0 place-items-center rounded-full border-[1.5px]",
        state === "current"
          ? "border-sky-600 dark:border-sky-400"
          : "border-muted-foreground/40",
      )}
    >
      {state === "current" && (
        <span className="size-1.5 rounded-full bg-sky-600 dark:bg-sky-400" />
      )}
    </span>
  );
}

export function ThreadDetails({
  data,
  t,
  agent,
  project,
  go,
}: {
  data: V3Data;
  t: V3Thread;
  agent: V3Agent | undefined;
  /** A chat's project; a ticket thread shows its ticket instead. */
  project?: V3Project;
  go: V3PageProps["go"];
}) {
  const ticketId = t.ticketId;
  const plan = t.plan ?? [];
  const changes = t.changes ?? [];
  const helpers = t.helpers ?? [];
  const planDone = plan.filter((p) => p.state === "done").length;
  const via = viaOf(data, agent);
  return (
    <div className="mx-auto w-full max-w-[560px] px-6 pt-4 pb-10 text-[13px]">
      <Kv k="Agent">
        {agent ? (
          <button
            type="button"
            onClick={() => go({ page: "agent", id: agent.id })}
            className="flex items-center gap-1.5 hover:underline"
          >
            <AgentAvatar data={data} agent={agent} size={18} />
            {agent.name}
          </button>
        ) : (
          // A fired agent has no page to open.
          <span className="flex items-center gap-1.5">
            <AgentAvatar data={data} agent={undefined} size={18} />
            {FORMER_AGENT}
          </span>
        )}
      </Kv>
      {ticketId ? (
        <Kv k="Ticket">
          <button
            type="button"
            onClick={() => go({ page: "ticket", id: ticketId })}
            className={link}
          >
            {ticketId}
          </button>
        </Kv>
      ) : (
        project && (
          <Kv k="Project">
            <button
              type="button"
              onClick={() => go({ page: "project", id: project.id })}
              className="flex items-center gap-1.5 hover:underline"
            >
              <ProjectMark name={project.name} tone={project.tone} />
              {project.name}
            </button>
          </Kv>
        )
      )}
      {via ? (
        <Kv k="Reached through">{via.label}</Kv>
      ) : (
        t.model && <Kv k="Model">{t.model}</Kv>
      )}
      {t.folder && (
        <Kv k="Folder">
          <span className="truncate font-mono text-[12px]">{t.folder}</span>
        </Kv>
      )}
      {t.branch && (
        <Kv k="Branch">
          <span className="truncate font-mono text-[12px]">{t.branch}</span>
        </Kv>
      )}
      <Kv k="Started">
        {t.startedAt} · {span(t.minutes)}
      </Kv>
      {t.context !== undefined && t.context > 0 && (
        <Kv k="Context">
          <Meter value={t.context} className="w-[60px]" />
          {t.context}%
        </Kv>
      )}

      {plan.length > 0 && (
        <>
          <Head count={`${planDone} of ${plan.length}`}>Plan</Head>
          <ul className="space-y-2">
            {plan.map((p) => (
              <li
                key={p.text}
                className={cn(
                  "flex items-center gap-2",
                  p.state === "todo" && "text-muted-foreground/70",
                )}
              >
                <PlanDot state={p.state} />
                {p.text}
              </li>
            ))}
          </ul>
        </>
      )}

      {changes.length > 0 && (
        <>
          <Head
            count={`${changes.length} ${changes.length === 1 ? "file" : "files"}`}
          >
            Changes
          </Head>
          {changes.map((c) => (
            <div
              key={c.path}
              title={c.path}
              className="flex min-h-[29px] items-center justify-between gap-3"
            >
              <span className="truncate font-mono text-[12px]">
                {c.path.split("/").pop()}
              </span>
              <Diff add={c.add} del={c.del} />
            </div>
          ))}
        </>
      )}

      {helpers.length > 0 && (
        <>
          <Head count={String(helpers.length)}>Helpers</Head>
          {helpers.map((h) => (
            <div
              key={h.text}
              className="flex min-h-[29px] items-center justify-between gap-3"
            >
              <span className="flex min-w-0 items-center gap-2">
                <WorkflowIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{h.text}</span>
              </span>
              <span className="text-[12.5px] text-muted-foreground/70">
                {h.took}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
