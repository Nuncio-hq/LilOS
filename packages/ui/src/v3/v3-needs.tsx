import { type ReactNode, useEffect, useMemo, useState } from "react";
import { cn } from "../lib/utils";
import {
  Avatar,
  ago,
  Btn,
  INK,
  Meter,
  Page,
  RowButton,
  Section,
  StatusDot,
  StatusPill,
  Title,
} from "./v3-bits";
import { agentOf, goalOf, threadsOf, ticketOf } from "./v3-model";
import type { V3Ask, V3Data, V3PageProps } from "./v3-types";

/* Needs you: the one place for everything waiting on the chairman. The
   oldest ask is open with its four answers (ask, why, yes, no); every ask
   also carries the CEO's default, so the company never waits forever. */

const CHIP =
  "inline-flex shrink-0 items-center rounded-[10px] bg-yellow-50 px-[9px] py-px font-medium text-[12.5px] text-yellow-700 dark:bg-yellow-400/12 dark:text-yellow-300";

/** Keys typed into a field must never trigger the A / D / J / K shortcuts. */
function typingInField(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  return (
    el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)
  );
}

/** One line in a list: a quiet kind word, title + meta, then what's on the right. */
function Item({
  kind,
  title,
  meta,
  onClick,
  children,
}: {
  kind: string;
  title: string;
  meta: ReactNode;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <RowButton
      onClick={onClick}
      className="flex min-h-[54px] items-center gap-3.5 border-[var(--v3-line)] border-b py-2"
    >
      <span className="w-24 shrink-0 text-[12.5px] text-muted-foreground/70">
        {kind}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-foreground">{title}</div>
        <div className="mt-px truncate text-[13px] text-muted-foreground">
          {meta}
        </div>
      </div>
      {children}
    </RowButton>
  );
}

/** Buttons inside a clickable row act on their own; they must not open the row. */
function Stop({ children }: { children: ReactNode }) {
  return (
    <span
      className="flex items-center gap-2"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {children}
    </span>
  );
}

function OpenAsk({
  ask,
  data,
  go,
  act,
  allow,
  setAllow,
}: {
  ask: V3Ask;
  data: V3Data;
  go: V3PageProps["go"];
  act: V3PageProps["act"];
  allow: boolean;
  setAllow: (v: boolean) => void;
}) {
  const from = agentOf(data, ask.from);
  const ticket = ticketOf(data, ask.ticketId);
  const goal = ticket?.goalId ? goalOf(data, ticket.goalId) : undefined;
  const isQuestion = ask.kind === "question";
  const rows: [string, string, boolean?][] = [
    ["The ask", ask.ask],
    ["Why", ask.why],
    [isQuestion ? "If yes" : "If you approve", ask.ifYes],
    [isQuestion ? "If no" : "If you deny", ask.ifNo, true],
  ];

  return (
    <div className="my-3 mb-1 rounded-[10px] border border-[var(--v3-line)] px-[18px] pt-4 pb-3.5">
      <div className="flex items-baseline gap-2.5 font-semibold text-[17px] text-foreground">
        <span className="font-normal text-[14px] text-muted-foreground/70">
          {ask.ticketId}
        </span>
        {ask.title}
        <StatusPill status="needs" className="ml-auto self-center" />
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-[13px] text-muted-foreground">
        <Avatar name={from.name} tone={from.tone} size={18} />
        <span>
          {from.name} asks · waiting {ago(ask.waiting)}
          {goal && ` · goal ${goal.title}`}
        </span>
      </div>

      <div className="mt-4 mb-1 grid grid-cols-[120px_1fr] gap-x-3.5 gap-y-[9px] text-[14px] leading-[1.5]">
        {rows.map(([k, v, quiet]) => (
          <div key={k} className="contents">
            <span className="text-muted-foreground">{k}</span>
            <span
              className={cn(
                quiet ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {v}
            </span>
          </div>
        ))}
        {ask.spend && (
          <>
            <span className="text-muted-foreground">Spend</span>
            <span className="flex items-center gap-2.5 text-[13px] text-muted-foreground">
              <Meter
                value={(ask.spend.used / ask.spend.cap) * 100}
                className="w-[120px]"
              />
              ${ask.spend.used} of ${ask.spend.cap} this month
            </span>
          </>
        )}
      </div>

      <div className="mt-3 flex">
        <span className={CHIP}>
          If you don't answer by {ask.fallback.at}: the CEO {ask.fallback.does}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {ask.allowRule && (
          <label className="mr-auto flex cursor-pointer items-center gap-2 text-[13px] text-muted-foreground">
            <input
              type="checkbox"
              checked={allow}
              onChange={(e) => setAllow(e.target.checked)}
              className="size-3.5 cursor-pointer accent-foreground"
            />
            {ask.allowRule}
          </label>
        )}
        <span
          className={cn(
            "flex flex-wrap items-center gap-2",
            !ask.allowRule && "ml-auto",
          )}
        >
          <Btn onClick={() => go({ page: "ticket", id: ask.ticketId })}>
            Open ticket
          </Btn>
          {isQuestion ? (
            (ask.options ?? []).map((o) => (
              <Btn key={o} onClick={() => act.answer(ask.id, o)}>
                {o}
              </Btn>
            ))
          ) : (
            <>
              <Btn onClick={() => act.deny(ask.id)}>Deny</Btn>
              <Btn primary onClick={() => act.approve(ask.id, allow)}>
                Approve{ask.spend ? ` $${ask.spend.amount}` : ""}
              </Btn>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

export function V3Needs({ data, go, act }: V3PageProps) {
  // Oldest first: the longest wait is the most overdue.
  const asks = useMemo(
    () => [...data.asks].sort((a, b) => b.waiting - a.waiting),
    [data.asks],
  );
  const [selected, setSelected] = useState<string>();
  const [allow, setAllow] = useState<Record<string, boolean>>({});
  const current = asks.find((a) => a.id === selected) ?? asks[0];
  const index = current ? asks.indexOf(current) : -1;

  // Keys read the latest asks through the effect deps; re-binding is cheap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typingInField(e) || !current)
        return;
      const k = e.key.toLowerCase();
      if (k === "a" && current.kind === "approval")
        act.approve(current.id, allow[current.id]);
      else if (k === "d" && current.kind === "approval") act.deny(current.id);
      else if (k === "j")
        setSelected(asks[Math.min(index + 1, asks.length - 1)].id);
      else if (k === "k") setSelected(asks[Math.max(index - 1, 0)].id);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, allow, asks, current, index]);

  const stuck = data.tickets.filter((t) => t.status === "stuck" && t.fallback);
  const results = useMemo(() => {
    const rows: {
      key: string;
      title: string;
      ticketId: string;
      by: string;
      note: string;
      minutes: number;
      threadId?: string;
      unseen: boolean;
    }[] = [];
    const seenTickets = new Set<string>();
    for (const th of data.threads.filter((t) => t.unseen)) {
      const t = ticketOf(data, th.ticketId);
      seenTickets.add(th.ticketId);
      rows.push({
        key: th.id,
        title: th.title,
        ticketId: th.ticketId,
        by: th.agentId,
        note: th.quote ? `“${th.quote}”` : (th.summary ?? ""),
        minutes: t?.doneAgo ?? t?.since ?? 0,
        threadId: th.id,
        unseen: true,
      });
    }
    for (const t of data.tickets) {
      if (
        t.status !== "done" ||
        (t.doneAgo ?? Number.POSITIVE_INFINITY) >= 180 ||
        seenTickets.has(t.id)
      )
        continue;
      const th = threadsOf(data, t.id).at(-1);
      const pr = t.result?.pr;
      rows.push({
        key: t.id,
        title: t.title,
        ticketId: t.id,
        by: t.owner,
        note: th?.summary ?? (pr ? `PR #${pr.num} · ${pr.branch}` : "Done"),
        minutes: t.doneAgo ?? 0,
        threadId: th?.id,
        unseen: false,
      });
    }
    return rows.sort((a, b) => a.minutes - b.minutes);
  }, [data]);

  const others = asks.filter((a) => a !== current);
  const handleAt = stuck.map((t) => t.fallback?.at).sort()[0];

  return (
    <Page>
      <Title>Needs you</Title>

      <div className="flex flex-wrap gap-x-[18px] gap-y-1.5 text-[13.5px] text-muted-foreground">
        <span className="inline-flex items-center gap-[7px]">
          <StatusDot status="needs" />
          <span>
            <b className="font-semibold text-foreground">{asks.length}</b>{" "}
            waiting on you
          </span>
        </span>
        {stuck.length > 0 && (
          <span className="inline-flex items-center gap-[7px]">
            <StatusDot status="waiting" />
            <span>
              <b className="font-semibold text-foreground">{stuck.length}</b>{" "}
              the CEO will handle
              {handleAt && ` at ${handleAt}`}
            </span>
          </span>
        )}
        <span className="inline-flex items-center gap-[7px]">
          <StatusDot status="working" />
          <span>
            <b className="font-semibold text-foreground">{results.length}</b>{" "}
            results to look at
          </span>
        </span>
      </div>

      {current ? (
        <>
          <OpenAsk
            ask={current}
            data={data}
            go={go}
            act={act}
            allow={!!allow[current.id]}
            setAllow={(v) => setAllow((s) => ({ ...s, [current.id]: v }))}
          />
          <p className="mt-2 text-[12.5px] text-muted-foreground/70">
            A approve · D deny · J/K move
          </p>
        </>
      ) : (
        <p className="mt-6 border-[var(--v3-line)] border-y py-3.5 text-[14px] text-muted-foreground">
          You're all caught up
        </p>
      )}

      {others.length > 0 && (
        <>
          <Section title="Waiting on you" count={`${others.length} more`} />
          <div className="border-[var(--v3-line)] border-t">
            {others.map((a) => {
              const from = agentOf(data, a.from);
              return (
                <Item
                  key={a.id}
                  kind={a.kind === "question" ? "Question" : "Approval"}
                  title={a.title}
                  onClick={() => setSelected(a.id)}
                  meta={
                    <>
                      {a.ticketId} ·{" "}
                      <b className="font-medium text-foreground">{from.name}</b>{" "}
                      · waiting {ago(a.waiting)}
                    </>
                  }
                >
                  <span className={CHIP}>
                    {a.fallback.at} {a.fallback.does}
                  </span>
                </Item>
              );
            })}
          </div>
        </>
      )}

      {stuck.length > 0 && (
        <>
          <Section title="The CEO will handle it — unless you step in" />
          <div className="border-[var(--v3-line)] border-t">
            {stuck.map((t) => {
              const thread = threadsOf(data, t.id).find(
                (x) => x.status === "stuck",
              );
              const open = () =>
                thread
                  ? go({ page: "thread", id: thread.id })
                  : go({ page: "ticket", id: t.id });
              return (
                <Item
                  key={t.id}
                  kind="Stuck"
                  title={t.title}
                  onClick={open}
                  meta={
                    <>
                      {t.id} ·{" "}
                      <b className="font-medium text-foreground">
                        {agentOf(data, t.owner).name}
                      </b>{" "}
                      · <span className={INK.stuck}>{t.stuckWhy}</span>
                    </>
                  }
                >
                  <span className={CHIP}>
                    {t.fallback?.at} {t.fallback?.does}
                  </span>
                  <Stop>
                    {thread && (
                      <Btn small onClick={() => act.stop(thread.id)}>
                        Stop instead
                      </Btn>
                    )}
                    <Btn small onClick={open}>
                      Open
                    </Btn>
                  </Stop>
                </Item>
              );
            })}
          </div>
        </>
      )}

      {results.length > 0 && (
        <>
          <Section title="Results to look at — no action needed" />
          <div className="border-[var(--v3-line)] border-t">
            {results.map((r) => (
              <Item
                key={r.key}
                kind="Finished"
                title={r.title}
                onClick={() => {
                  if (r.threadId) {
                    if (r.unseen) act.markSeen(r.threadId);
                    go({ page: "thread", id: r.threadId });
                  } else go({ page: "ticket", id: r.ticketId });
                }}
                meta={
                  <>
                    {r.ticketId} ·{" "}
                    <b className="font-medium text-foreground">
                      {agentOf(data, r.by).name}
                    </b>
                    {r.note && ` · ${r.note}`}
                  </>
                }
              >
                <span className="shrink-0 text-[13px] text-muted-foreground/70">
                  {ago(r.minutes)} ago
                </span>
              </Item>
            ))}
          </div>
        </>
      )}
    </Page>
  );
}
