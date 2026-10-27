import { FolderIcon, TargetIcon, UsersIcon } from "lucide-react";
import { useState } from "react";
import { Meter, Page, Prop, Section, Title, useTick } from "./v3-bits";
import { useFoldPrefs } from "./v3-layout-prefs";
import { AgentAvatar, CeoMark, ProjectMark } from "./v3-marks";
import {
  agentOf,
  FORMER_AGENT,
  goalProgress,
  listedThreads,
  projectOf,
  threadProjectId,
} from "./v3-model";
import { RowButton } from "./v3-open-record";
import type { V3PageProps } from "./v3-page-types";
import { TicketRow } from "./v3-rows";
import { sectionedThreads } from "./v3-sections";
import { Fold, ThreadRow } from "./v3-threads-rows";
import type { V3Thread } from "./v3-types";

/* A project page (D-#771): the folder, then the project's threads in the
   same statuses the Threads page uses (#887), and, once the company has
   tickets, its goals and tickets. A thread is in a project or it is a
   plain chat, so this list is the whole project. */

/** Done threads shown before "Show all": a busy project has hundreds. */
const DONE_SHOWN = 12;

export function V3ProjectPage({
  data,
  go,
  act,
  id,
}: V3PageProps & { id: string }) {
  const project = projectOf(data, id);
  const [showDone, setShowDone] = useState(false);
  const [allDone, setAllDone] = useState(false);
  /* A wake time passing quietly returns its thread to Active; tick so the
     list re-reads the clock without waiting for a touch. */
  useTick(30_000);
  const { folds, setFold } = useFoldPrefs();
  if (!project) {
    return (
      <Page>
        <p className="text-[14px] text-muted-foreground">Project not found.</p>
      </Page>
    );
  }
  // Goals and tickets belong to M2; without them their parts are not drawn.
  const withTickets = data.features.tickets;
  const goals = withTickets
    ? data.goals.filter((g) => g.projectId === project.id)
    : [];
  const tickets = withTickets
    ? data.tickets.filter((t) => t.projectId === project.id)
    : [];
  const open = tickets.filter((t) => t.status !== "done");
  const done = tickets.filter((t) => t.status === "done");
  /* A thread is the project's by its own record, its ticket, or a folder
     inside the project's — a `.lilos/wt/` worktree lists here on its own
     (#854). Helpers have no row either (D-#847): they show inside their
     parent. */
  const mine = listedThreads(data.threads).filter(
    (t) => threadProjectId(data, t) === project.id,
  );
  /* The same statuses the Threads page draws (#887): Pinned · Active ·
     Working · Snoozed · Done — a thread reads the same here as there.
     `sectionedThreads` buckets every thread, so keep only this project's;
     a done thread still belongs to its project. */
  const inProject = (t: V3Thread) => threadProjectId(data, t) === project.id;
  const all = sectionedThreads(data);
  const s = {
    pinned: all.pinned.filter(inProject),
    active: all.active.filter(inProject),
    working: all.working.filter(inProject),
    snoozed: all.snoozed.filter(inProject),
    settled: all.settled.filter(inProject),
  };
  const total = mine.length + s.settled.length;
  const doneShown = allDone ? s.settled : s.settled.slice(0, DONE_SHOWN);
  // Who is on it: the owners of its open tickets and whoever has a thread.
  const onIt = [
    ...new Set([
      ...open.map((t) => t.owner).filter((id) => id.length > 0),
      ...mine.map((t) => t.agentId),
    ]),
  ];
  const people = onIt.flatMap((id) => agentOf(data, id) ?? []);
  // A fired agent can still hold an open ticket: it is on the project, but
  // there is no page to open and no name to give.
  const formerPeople = onIt.length > people.length;

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
      {project.about && (
        <p className="text-[14.5px] text-muted-foreground">{project.about}</p>
      )}

      <div className="mt-4">
        <Prop icon={<FolderIcon />} label="Folder">
          <span className="font-mono text-[13px] text-foreground">
            {project.folder}
          </span>
        </Prop>
        {withTickets && (
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
        )}
        <Prop icon={<UsersIcon />} label="Agents on it">
          {people.length === 0 && !formerPeople && (
            <span className="text-muted-foreground">Nobody right now</span>
          )}
          {people.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => go({ page: "agent", id: a.id })}
              className="inline-flex items-center gap-1.5 text-foreground hover:underline"
            >
              <AgentAvatar data={data} agent={a} />
              {a.name}
              {a.id === data.ceoId && <CeoMark />}
            </button>
          ))}
          {formerPeople && (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <AgentAvatar data={data} agent={undefined} />
              {FORMER_AGENT}
            </span>
          )}
        </Prop>
      </div>

      {withTickets && (
        <>
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
        </>
      )}

      <Section title="Threads" count={total} />
      <div data-project-threads className="text-[13.5px]">
        {total === 0 && (
          <p className="border-[var(--v3-line)] border-t py-3 text-[14px] text-muted-foreground">
            No threads here yet.
          </p>
        )}
        {s.pinned.length > 0 && (
          <>
            <div className="pt-1 pb-1 text-[12.5px] text-muted-foreground/70">
              Pinned
            </div>
            {s.pinned.map((t) => (
              <ThreadRow
                key={t.id}
                data={data}
                t={t}
                go={go}
                act={act}
                drop="project"
              />
            ))}
          </>
        )}
        {s.active.length > 0 && (
          <>
            <div className="pt-2.5 pb-1 text-[12.5px] text-muted-foreground/70">
              Active
            </div>
            {s.active.map((t) => (
              <ThreadRow
                key={t.id}
                data={data}
                t={t}
                go={go}
                act={act}
                drop="project"
              />
            ))}
          </>
        )}
        <Fold
          title="Working"
          count={s.working.length}
          open={folds[`project:${id}:working`] === true}
          onToggle={(o) => setFold(`project:${id}:working`, o)}
          marker="working"
        >
          {s.working.map((t) => (
            <ThreadRow
              key={t.id}
              data={data}
              t={t}
              go={go}
              act={act}
              drop="project"
            />
          ))}
        </Fold>
        <Fold
          title="Snoozed"
          count={s.snoozed.length}
          open={folds[`project:${id}:snoozed`] === true}
          onToggle={(o) => setFold(`project:${id}:snoozed`, o)}
          marker="snoozed"
        >
          {s.snoozed.map((t) => (
            <ThreadRow
              key={t.id}
              data={data}
              t={t}
              go={go}
              act={act}
              drop="project"
            />
          ))}
        </Fold>
        <Fold
          title="Done"
          count={s.settled.length}
          open={folds[`project:${id}:settled`] === true}
          onToggle={(o) => setFold(`project:${id}:settled`, o)}
          marker="settled"
        >
          <div data-settled-list>
            {doneShown.map((t) => (
              <ThreadRow
                key={t.id}
                data={data}
                t={t}
                go={go}
                act={act}
                settled
                drop="project"
              />
            ))}
          </div>
          {s.settled.length > DONE_SHOWN && (
            <button
              type="button"
              onClick={() => setAllDone((v) => !v)}
              className="mt-1.5 text-[13.5px] text-muted-foreground hover:text-foreground"
            >
              {allDone ? "▾ Show fewer" : `▸ Show all ${s.settled.length}`}
            </button>
          )}
        </Fold>
      </div>

      {withTickets && (
        <>
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
        </>
      )}
    </Page>
  );
}
