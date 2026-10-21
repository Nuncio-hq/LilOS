import { AlertCircleIcon, GlobeIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { Btn, Meter, Spinner, TicketId, useTick } from "./v3-bits";
import type { V3Data } from "./v3-data-types";
import { elapsedAt, streamTail, ThreadPill, turnCount } from "./v3-live";
import { AgentAvatar, CeoMark } from "./v3-marks";
import { agentOf, FORMER_AGENT, threadTag } from "./v3-model";
import { useOpenRecord } from "./v3-open-record";
import type { V3PageProps } from "./v3-page-types";
import { viaOf } from "./v3-rows";
import type { V3Agent, V3Thread } from "./v3-types";

/* One card on the live board: who, what, where it is right now, and the
   buttons to deal with it without opening the thread. */

const shell =
  "flex min-h-[206px] min-w-0 cursor-pointer flex-col gap-2.5 rounded-[10px] border border-[var(--v3-line)] p-3.5 pb-3 text-left outline-none transition-colors hover:bg-[var(--v3-hover)] focus-visible:bg-[var(--v3-hover)]";

const mono = "font-mono text-[11.5px] leading-[1.6]";

/** Buttons live inside a clickable card; clicks on them must not open it. */
function Actions({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("flex gap-2", className)}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

function Frame({
  onOpen,
  selected,
  children,
}: {
  onOpen: () => void;
  /** Its thread is open in the side peek. */
  selected?: boolean;
  children: ReactNode;
}) {
  return (
    // The card holds buttons, so it cannot itself be a <button>.
    <div
      role="button"
      tabIndex={0}
      aria-current={selected || undefined}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) onOpen();
      }}
      className={cn(
        shell,
        selected && "border-foreground/45 bg-[var(--v3-hover)]",
      )}
    >
      {children}
    </div>
  );
}

/** The soft box with the last two output lines. Lines arrive over time.
    No lines, no box — an empty grey rectangle is not a tail (D-#772). */
function Tail({ lines }: { lines: { key: string | number; text: string }[] }) {
  if (lines.length === 0) return null;
  return (
    <div
      className={cn(
        "overflow-hidden whitespace-nowrap rounded-[7px] bg-[var(--v3-soft)] px-2.5 py-1.5 text-muted-foreground",
        mono,
      )}
    >
      {lines.map((l) => (
        <div key={l.key} className="lilos-v3-line-in truncate">
          {l.text}
        </div>
      ))}
    </div>
  );
}

/** The card's last line: a label on the left, the context meter on the right.
   Either may be absent; with neither there is no line at all. */
function Foot({
  children,
  context,
}: {
  children?: ReactNode;
  context?: number;
}) {
  if (children === undefined && context === undefined) return null;
  return (
    <div className="mt-auto flex items-center gap-2.5 text-[12.5px] text-muted-foreground">
      {children !== undefined && (
        <span className="whitespace-nowrap">{children}</span>
      )}
      {context !== undefined && (
        <>
          <Meter value={context} className="flex-1" />
          <span>{context}%</span>
        </>
      )}
    </div>
  );
}

function Head({
  data,
  agent,
  pill,
}: {
  data: V3Data;
  agent: V3Agent | undefined;
  pill: ReactNode;
}) {
  const via = viaOf(data, agent);
  return (
    <div className="flex items-center gap-2 font-medium text-[13.5px]">
      <AgentAvatar data={data} agent={agent} />
      {agent?.name ?? FORMER_AGENT}
      {agent?.id === data.ceoId && <CeoMark />}
      {via && (
        <span className="font-normal text-[11.5px] text-muted-foreground/70">
          via {via.label}
        </span>
      )}
      <span className="ml-auto">{pill}</span>
    </div>
  );
}

/** The working card owns its own clock, so only live cards re-render. */
function WorkingBody({ t }: { t: V3Thread }) {
  const n = useTick(1000);
  const lines = t.live?.lines ?? [];
  // Two lines showing at first, then one more every two seconds. Test-run
  // output replays forever; a one-off listing stops when it is all shown.
  const grown = 2 + Math.floor(n / 2);
  const replays = lines.some((l) => l.includes("(run "));
  const streamed = streamTail(
    lines,
    replays ? grown : Math.min(lines.length, grown),
    2,
  );
  const shown = streamed.length
    ? streamed
    : (t.tail ?? []).map((text) => ({ key: text, text }));
  const turns = turnCount(t);
  const where =
    turns === undefined
      ? undefined
      : t.step === undefined
        ? `Turn ${turns}`
        : `Turn ${turns} · step ${t.step}`;
  return (
    <>
      {t.now && (
        <div className="flex min-w-0 items-center gap-2 text-[13px]">
          <Spinner />
          <span className="min-w-0 flex-1 truncate font-mono">
            {t.now.text}
          </span>
          <span className="whitespace-nowrap text-[12px] text-muted-foreground/70">
            {elapsedAt(t.now.elapsed, n)}
          </span>
        </div>
      )}
      <Tail lines={shown} />
      <Foot context={t.context}>{where}</Foot>
    </>
  );
}

export function ThreadCard({
  t,
  data,
  go,
  act,
}: V3PageProps & { t: V3Thread }) {
  const agent = agentOf(data, t.agentId);
  const isOpen = useOpenRecord();
  const open = () => {
    if (t.unseen) act.markSeen(t.id);
    go({ page: "thread", id: t.id });
  };
  const askId = t.askId;
  const ask = askId ? data.asks.find((a) => a.id === askId) : undefined;
  const ticketId = t.ticketId;
  const handOff = act.handOff;
  // A stuck ticket is handed to the Marketer; with none on the team there is
  // no hand-off to offer.
  const handTo = agentOf(data, "marketer");
  // A failed thread may carry no reason: then the card is just title, agent
  // and Open, instead of an empty alert line.
  const reason = t.status === "stuck" || t.stuck !== undefined;
  const turns = turnCount(t);

  return (
    <Frame onOpen={open} selected={isOpen("thread", t.id)}>
      <Head data={data} agent={agent} pill={<ThreadPill status={t.status} />} />
      <div className="font-semibold text-[14.5px] leading-[1.35]">
        {t.unseen && (
          <span
            aria-hidden
            // Test hook: the card's unseen dot (#563).
            data-thread-unseen
            className="mr-1.5 inline-block size-[7px] rounded-full bg-sky-600 dark:bg-sky-400"
          />
        )}
        <TicketId id={threadTag(data, t)} className="mr-2 font-normal" />
        {t.title}
      </div>

      {t.status === "working" && <WorkingBody t={t} />}

      {t.status === "needs" && (
        <>
          {t.quote && (
            <div className="text-[13px] text-muted-foreground leading-normal">
              {t.quote}
            </div>
          )}
          {/* A question is answered with its own options, or in the thread. */}
          {askId && ask?.kind !== "question" && (
            <Actions>
              <Btn small onClick={() => act.deny(askId)}>
                Deny
              </Btn>
              <Btn small primary onClick={() => act.approve(askId)}>
                Approve
              </Btn>
            </Actions>
          )}
          {askId && ask?.kind === "question" && !!ask.options?.length && (
            <Actions>
              {ask.options.map((o) => (
                <Btn key={o} small onClick={() => act.answer(askId, o)}>
                  {o}
                </Btn>
              ))}
            </Actions>
          )}
          <Foot context={t.context}>Waiting {ask?.waiting ?? 0}m</Foot>
        </>
      )}

      {(t.status === "stuck" || t.status === "failed") && (
        <>
          {reason && (
            <>
              <div className="flex min-w-0 items-center gap-2 text-[13px] text-red-600 dark:text-red-300">
                {t.now?.kind === "web" ? (
                  <GlobeIcon className="size-3.5 shrink-0" />
                ) : (
                  <AlertCircleIcon className="size-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">{t.stuck?.what}</span>
                <span className="whitespace-nowrap text-[12px]">
                  {t.now?.elapsed}
                </span>
              </div>
              <Tail
                lines={(t.stuck?.detail ?? []).map((text) => ({
                  key: text,
                  text,
                }))}
              />
            </>
          )}
          <Actions className="mt-auto">
            {t.status === "stuck" ? (
              <Btn small onClick={() => act.stop(t.id)}>
                Stop
              </Btn>
            ) : (
              <Btn small onClick={open}>
                Open
              </Btn>
            )}
            {ticketId && handOff && handTo && (
              <Btn small onClick={() => handOff(ticketId, handTo.id)}>
                Hand to {handTo.name}
              </Btn>
            )}
          </Actions>
        </>
      )}

      {t.status === "done" && (
        <>
          {t.quote ? (
            <div className="text-[13px] text-muted-foreground leading-normal">
              “{t.quote}”
            </div>
          ) : (
            t.summary && (
              <div className="text-[13px] text-muted-foreground leading-normal">
                {t.summary}
              </div>
            )
          )}
          <Foot>
            {turns === undefined
              ? `${t.minutes}m`
              : `${turns} turns · ${t.minutes}m`}
          </Foot>
        </>
      )}
    </Frame>
  );
}

/** An agent with nothing live: a quiet card that opens the agent page. */
export function IdleCard({
  data,
  agent,
  go,
}: {
  data: V3Data;
  agent: V3Agent;
  go: V3PageProps["go"];
}) {
  return (
    <Frame onOpen={() => go({ page: "agent", id: agent.id })}>
      <Head data={data} agent={agent} pill={<ThreadPill status="idle" />} />
      <div className="font-semibold text-[14.5px] leading-[1.35]">
        {agent.next ?? agent.role}
      </div>
      <div className="text-[13px] text-muted-foreground leading-normal">
        Asleep.{agent.schedule && ` ${agent.schedule}.`}
      </div>
    </Frame>
  );
}
