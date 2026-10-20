import { FolderIcon, TargetIcon, UsersIcon } from "lucide-react";
import { useState } from "react";
import {
  AgentAvatar,
  Meter,
  Page,
  ProjectMark,
  Prop,
  RowButton,
  Section,
  Title,
} from "./v3-bits";
import { agentOf, FORMER_AGENT, goalProgress, projectOf } from "./v3-model";
import { ThreadRow, TicketRow } from "./v3-rows";
import type { V3PageProps } from "./v3-types";

/* A project page: the folder, its goals, and everything moving inside it. */

export function V3ProjectPage({ data, go, id }: V3PageProps & { id: string }) {
  const project = projectOf(data, id);
  const [showDone, setShowDone] = useState(false);
  if (!project) {
    return (
      <Page>
        <p className="text-[14px] text-muted-foreground">Project not found.</p>
      </Page>
    );
  }
  const goals = data.goals.filter((g) => g.projectId === project.id);
  const tickets = data.tickets.filter((t) => t.projectId === project.id);
  const open = tickets.filter((t) => t.status !== "done");
  const done = tickets.filter((t) => t.status === "done");
  const ticketIds = new Set(tickets.map((t) => t.id));
  const live = data.threads.filter(
    (t) =>
      (t.projectId === project.id ||
        (t.ticketId !== undefined && ticketIds.has(t.ticketId))) &&
      t.status !== "done" &&
      t.status !== "idle",
  );
  const ownerIds = [...new Set(open.map((t) => t.owner))];
  const owners = ownerIds.flatMap((id) => agentOf(data, id) ?? []);
  // A fired agent can still hold an open ticket: it is on the project, but
  // there is no page to open and no name to give.
  const formerOwners = ownerIds.length > owners.length;

  return (
    <Page wide>
      <Title kicker="Project">
        <span className="inline-flex items-center gap-3">
          <ProjectMark
            name={project.name}
            tone={project.tone}
            className="size-8 rounded-lg text-[16px]"
          />
          {project.name}
        </span>
      </Title>
      <p className="text-[14.5px] text-muted-foreground">{project.about}</p>

      <div className="mt-4">
        <Prop icon={<FolderIcon />} label="Folder">
          <span className="font-mono text-[13px] text-foreground">
            {project.folder}
          </span>
        </Prop>
        <Prop icon={<TargetIcon />} label="Goals">
          {goals.length === 0 && (
            <span className="text-muted-foreground">None yet</span>
          )}
          {goals.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => go({ page: "goal", id: g.id })}
              className="text-foreground hover:underline"
            >
              {g.title}
            </button>
          ))}
        </Prop>
        <Prop icon={<UsersIcon />} label="Agents on it">
          {owners.length === 0 && !formerOwners && (
            <span className="text-muted-foreground">Nobody right now</span>
          )}
          {owners.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => go({ page: "agent", id: a.id })}
              className="inline-flex items-center gap-1.5 text-foreground hover:underline"
            >
              <AgentAvatar data={data} agent={a} />
              {a.name}
            </button>
          ))}
          {formerOwners && (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <AgentAvatar data={data} agent={undefined} />
              {FORMER_AGENT}
            </span>
          )}
        </Prop>
      </div>

      <Section title="Goals" count={goals.length} />
      <div className="border-[var(--v3-line)] border-t">
        {goals.map((g) => {
          const p = goalProgress(data, g.id);
          return (
            <RowButton
              key={g.id}
              onClick={() => go({ page: "goal", id: g.id })}
              className="flex min-h-[46px] items-center gap-3.5 border-[var(--v3-line)] border-b py-[7px]"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-foreground">
                  {g.title}
                </div>
                <div className="mt-px text-[13px] text-muted-foreground">
                  due {g.due}
                </div>
              </div>
              <Meter
                value={p.total ? (p.done / p.total) * 100 : 0}
                className="w-[150px] shrink-0"
              />
              <span className="w-11 text-right text-[13px] text-muted-foreground">
                {p.done} / {p.total}
              </span>
            </RowButton>
          );
        })}
      </div>

      <Section title="Open tickets" count={open.length} />
      <div className="border-[var(--v3-line)] border-t">
        {open.map((t) => (
          <TicketRow key={t.id} data={data} ticket={t} go={go} owner />
        ))}
      </div>

      <Section title="Live threads in this project" count={live.length} />
      <div className="border-[var(--v3-line)] border-t">
        {live.length === 0 && (
          <p className="py-3 text-[14px] text-muted-foreground">
            Nothing is running here right now.
          </p>
        )}
        {live.map((t) => (
          <ThreadRow key={t.id} data={data} thread={t} go={go} byAgent />
        ))}
      </div>

      <Section title="Done" count={done.length} />
      <button
        type="button"
        onClick={() => setShowDone((v) => !v)}
        className="text-[13.5px] text-muted-foreground hover:text-foreground"
      >
        {showDone ? "▾ Hide" : "▸ Show"} {done.length} finished{" "}
        {done.length === 1 ? "ticket" : "tickets"}
      </button>
      {showDone && (
        <div className="mt-1.5 border-[var(--v3-line)] border-t">
          {done.map((t) => (
            <TicketRow key={t.id} data={data} ticket={t} go={go} owner />
          ))}
        </div>
      )}
    </Page>
  );
}
