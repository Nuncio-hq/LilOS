import {
  ArrowRightIcon,
  CalendarIcon,
  CheckIcon,
  EyeIcon,
  GitPullRequestIcon,
  ImageIcon,
  PlugIcon,
  TargetIcon,
  UserIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import { ago, Btn, Diff, Page, Prop, Section, span, Title } from "./v3-bits";
import type { V3Data } from "./v3-data-types";
import { AgentAvatar, Avatar, StatusPill } from "./v3-marks";
import {
  agentNameOf,
  agentOf,
  FORMER_AGENT,
  goalOf,
  projectOf,
  threadsOf,
  ticketOf,
} from "./v3-model";
import { RowButton } from "./v3-open-record";
import type { V3PageProps, V3Route } from "./v3-page-types";
import { viaOf } from "./v3-rows";
import { AskNote, link, Person, StuckNote, WaitingOn } from "./v3-ticket-notes";
import type { V3Ticket } from "./v3-types";

/* One ticket as a Notion page: properties, the hands it passed through, steps
   with times, the result, and the conversation. */

/** The hand-off chain: one box per thread, oldest hand first. */
function Hands({
  data,
  t,
  go,
}: {
  data: V3Data;
  t: V3Ticket;
  go: (r: V3Route) => void;
}) {
  const threads = threadsOf(data, t.id);
  if (threads.length === 0) return null;
  const current =
    [...threads].reverse().find((x) => x.status !== "done") ??
    threads[threads.length - 1];
  return (
    <>
      <Section
        title="Hands"
        count={
          threads.length > 1
            ? `changed hands ${threads.length - 1}×`
            : undefined
        }
      />
      <div className="mt-1 flex items-stretch">
        {threads.map((th, i) => {
          const a = agentOf(data, th.agentId);
          return (
            <div key={th.id} className="flex min-w-0 flex-1 items-stretch">
              {i > 0 && (
                <span className="flex w-6 shrink-0 items-center justify-center text-muted-foreground/60">
                  <ArrowRightIcon className="size-3.5" />
                </span>
              )}
              <button
                type="button"
                onClick={() => go({ page: "thread", id: th.id })}
                className={cn(
                  "flex min-w-0 flex-1 flex-col items-start gap-1 rounded-[10px] border px-3.5 py-3 text-left text-[13px] transition-colors hover:bg-[var(--v3-hover)]",
                  th === current
                    ? "border-sky-300/60 bg-sky-50/60 dark:border-sky-400/30 dark:bg-sky-400/10"
                    : "border-[var(--v3-line)]",
                )}
              >
                <span className="flex items-center gap-2 text-[13.5px] font-medium">
                  <AgentAvatar data={data} agent={a} />
                  {a?.name ?? FORMER_AGENT}
                </span>
                <span className="w-full truncate">{th.title}</span>
                <span className="text-muted-foreground">
                  {span(th.minutes)}
                  {th.turns.length > 0 &&
                    ` · ${th.turns.length} ${th.turns.length === 1 ? "turn" : "turns"}`}
                </span>
                <StatusPill status={th.status} />
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}

function Progress({ data, t }: { data: V3Data; t: V3Ticket }) {
  if (t.progress.length === 0) return null;
  return (
    <>
      <Section title="Progress" />
      <ul className="mt-1">
        {t.progress.map((s) => (
          <li
            key={s.text}
            className={cn(
              "flex min-h-9 items-center gap-3 text-[14px]",
              s.state === "current" &&
                "-mx-2.5 rounded-[7px] bg-yellow-50/80 px-2.5 dark:bg-yellow-400/10",
            )}
          >
            <span
              className={cn(
                "grid size-[18px] shrink-0 place-items-center rounded-full",
                s.state === "done" && "bg-foreground text-background",
                s.state === "current" &&
                  "border-[1.6px] border-yellow-500 bg-[linear-gradient(90deg,var(--color-yellow-500)_50%,transparent_50%)]",
                s.state === "todo" && "border-[1.6px] border-foreground/20",
              )}
            >
              {s.state === "done" && (
                <CheckIcon className="size-3" strokeWidth={3} />
              )}
            </span>
            <span
              className={cn(
                "flex-1",
                s.state === "todo" && "text-muted-foreground/70",
              )}
            >
              {s.text}
              <span className="text-muted-foreground/70">
                {" "}
                · {s.by === "you" ? data.me : agentNameOf(data, s.by)}
              </span>
            </span>
            <span
              className={cn(
                "w-28 text-right text-[13px] text-muted-foreground",
                s.state === "current" &&
                  "font-medium text-yellow-700 dark:text-yellow-300",
              )}
            >
              {s.took}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Result({ t }: { t: V3Ticket }) {
  const r = t.result;
  if (!r) return null;
  return (
    <>
      <Section title="Result" />
      {r.pr && (
        <div className="flex min-h-[38px] items-center gap-2.5 text-[14px]">
          <GitPullRequestIcon className="size-4 text-muted-foreground/70" />
          <span className={link}>
            PR #{r.pr.num} · {r.pr.branch}
          </span>
          <Diff add={r.pr.add} del={r.pr.del} />
        </div>
      )}
      {r.files?.map((f) => (
        <div
          key={f.name}
          className="flex min-h-[38px] items-center gap-2.5 text-[14px]"
        >
          <ImageIcon className="size-4 text-muted-foreground/70" />
          <span className={link}>{f.name}</span>
          <span className="text-muted-foreground/70">{f.note}</span>
        </div>
      ))}
    </>
  );
}

function Updates({
  data,
  t,
  act,
}: { data: V3Data; t: V3Ticket } & Pick<V3PageProps, "act">) {
  const [text, setText] = useState("");
  const comment = act.comment;
  const send = () => {
    const body = text.trim();
    if (!body || !comment) return;
    comment(t.id, body);
    setText("");
  };
  // Without comments in the app and nothing said yet, there is no section.
  if (!comment && t.updates.length === 0) return null;
  return (
    <>
      <Section title="Updates" count={t.updates.length || undefined} />
      {t.updates.map((u) => {
        const you = u.by === "you";
        const by = you ? undefined : agentOf(data, u.by);
        const name = you ? data.me : (by?.name ?? FORMER_AGENT);
        return (
          <div key={`${u.by}-${u.ago}-${u.text}`} className="flex gap-3 py-2.5">
            {you ? (
              <Avatar name={name} tone="n" size={24} className="mt-0.5" />
            ) : (
              <AgentAvatar
                data={data}
                agent={by}
                size={24}
                className="mt-0.5"
              />
            )}
            <div>
              <div className="text-[13.5px]">
                <b className="mr-2 font-semibold">{name}</b>
                <span className="text-muted-foreground/70">
                  {ago(u.ago)} ago
                </span>
              </div>
              <p className="mt-0.5 text-[14.5px] leading-[1.55]">{u.text}</p>
            </div>
          </div>
        );
      })}
      {comment && (
        <div className="mt-3 flex items-center gap-3 border-[var(--v3-line)] border-t pt-3.5">
          <Avatar name={data.me} tone="n" size={24} />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Add a comment…"
            className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground/70"
          />
          <span className="shrink-0 text-[13px] text-muted-foreground/70">
            Type @ to ask an agent
          </span>
        </div>
      )}
    </>
  );
}

export function V3TicketPage({
  data,
  go,
  act,
  id,
}: V3PageProps & { id: string }) {
  const t = ticketOf(data, id);
  if (!t) {
    return (
      <Page>
        <p className="text-[14px] text-muted-foreground">
          Ticket not found.{" "}
          <button
            type="button"
            className={link}
            onClick={() => go({ page: "work" })}
          >
            Back to Work
          </button>
        </p>
      </Page>
    );
  }
  const project = projectOf(data, t.projectId);
  const goal = t.goalId ? goalOf(data, t.goalId) : undefined;
  const via = viaOf(data, agentOf(data, t.owner));
  return (
    <Page>
      <Title kicker={project ? `${t.id} · ${project.name}` : t.id}>
        {t.title}
      </Title>
      <div className="mb-2 flex">
        <Btn small onClick={() => act.ask(`About ${t.id}: `)}>
          {data.ceoId ? "Ask the CEO about this" : "Ask about this"}
        </Btn>
      </div>
      <div className="mt-1.5 mb-1">
        <Prop icon={<span className="size-4" />} label="Status">
          <StatusPill status={t.status} />
          {t.status === "planned" && t.startsAt && (
            <span className="text-muted-foreground">starts {t.startsAt}</span>
          )}
          {t.status === "done" && (
            <span className="text-muted-foreground">
              {ago(t.doneAgo ?? 0)} ago
            </span>
          )}
        </Prop>
        <WaitingOn data={data} t={t} go={go} />
        <Prop icon={<UserIcon />} label="Owner">
          <RowButton
            onClick={() => go({ page: "agent", id: t.owner })}
            className="py-1"
          >
            <Person data={data} id={t.owner} />
          </RowButton>
        </Prop>
        {t.reviewer && (
          <Prop icon={<EyeIcon />} label="Reviewer">
            <RowButton
              onClick={() => go({ page: "agent", id: t.reviewer ?? "" })}
              className="py-1"
            >
              <Person data={data} id={t.reviewer} />
            </RowButton>
          </Prop>
        )}
        {goal && (
          <Prop icon={<TargetIcon />} label="Goal">
            <button
              type="button"
              className={link}
              onClick={() => go({ page: "goal", id: goal.id })}
            >
              {goal.title}
            </button>
          </Prop>
        )}
        {t.started && (
          <Prop icon={<CalendarIcon />} label="Started">
            {t.started}
          </Prop>
        )}
      </div>
      {via && (
        <p className="mt-1 flex items-center gap-2 text-[13px] text-muted-foreground">
          <PlugIcon className="size-3.5 shrink-0" />
          Outside worker. Its steps come through the {via.label} connector.
        </p>
      )}
      {t.status === "stuck" && <StuckNote data={data} t={t} act={act} />}
      {t.waitingOn?.kind === "you" && <AskNote data={data} t={t} act={act} />}
      <Hands data={data} t={t} go={go} />
      <Progress data={data} t={t} />
      <Result t={t} />
      <Updates data={data} t={t} act={act} />
    </Page>
  );
}
