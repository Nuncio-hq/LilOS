import { AlertCircleIcon, GlobeIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import {
  Avatar,
  Btn,
  Meter,
  Spinner,
  TicketId,
  useOpenRecord,
  useTick,
} from "./v3-bits";
import { elapsedAt, streamTail, ThreadPill } from "./v3-live";
import { agentOf } from "./v3-model";
import type { V3Agent, V3PageProps, V3Thread } from "./v3-types";

/* One card on the live board: who, what, where it is right now, and the
   buttons to deal with it without opening the thread. */

const turnsOf = (t: V3Thread) => t.turns.reduce((m, x) => Math.max(m, x.n), 0);

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

/** The soft box with the last two output lines. Lines arrive over time. */
function Tail({ lines }: { lines: { key: string | number; text: string }[] }) {
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

function Foot({
  children,
  context,
}: {
  children: ReactNode;
  context?: number;
}) {
  return (
    <div className="mt-auto flex items-center gap-2.5 text-[12.5px] text-muted-foreground">
      <span className="whitespace-nowrap">{children}</span>
      {context !== undefined && (
        <>
          <Meter value={context} className="flex-1" />
          <span>{context}%</span>
        </>
      )}
    </div>
  );
}

function Head({ agent, pill }: { agent: V3Agent; pill: ReactNode }) {
  return (
    <div className="flex items-center gap-2 font-medium text-[13.5px]">
      <Avatar name={agent.name} tone={agent.tone} />
      {agent.name}
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
      <Foot context={t.context}>
        Turn {turnsOf(t)} · step {t.step}
      </Foot>
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
  const handTo = agentOf(data, "marketer");

  return (
    <Frame onOpen={open} selected={isOpen("thread", t.id)}>
      <Head agent={agent} pill={<ThreadPill status={t.status} />} />
      <div className="font-semibold text-[14.5px] leading-[1.35]">
        {t.unseen && (
          <span
            aria-hidden
            className="mr-1.5 inline-block size-[7px] rounded-full bg-sky-600 dark:bg-sky-400"
          />
        )}
        <TicketId id={t.ticketId ?? "Chat"} className="mr-2 font-normal" />
        {t.title}
      </div>

      {t.status === "working" && <WorkingBody t={t} />}

      {t.status === "needs" && (
        <>
          <div className="text-[13px] text-muted-foreground leading-normal">
            {t.quote}
          </div>
          {askId && (
            <Actions>
              <Btn small onClick={() => act.deny(askId)}>
                Deny
              </Btn>
              <Btn small primary onClick={() => act.approve(askId)}>
                Approve
              </Btn>
            </Actions>
          )}
          <Foot context={t.context}>Waiting {ask?.waiting ?? 0}m</Foot>
        </>
      )}

      {t.status === "stuck" && (
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
            lines={(t.stuck?.detail ?? []).map((text) => ({ key: text, text }))}
          />
          <Actions className="mt-auto">
            <Btn small onClick={() => act.stop(t.id)}>
              Stop
            </Btn>
            {t.ticketId && (
              <Btn small onClick={() => act.handOff(t.ticketId!, handTo.id)}>
                Hand to {handTo.name}
              </Btn>
            )}
          </Actions>
        </>
      )}

      {t.status === "done" && (
        <>
          <div className="text-[13px] text-muted-foreground leading-normal">
            “{t.quote}”
          </div>
          <Foot>
            {turnsOf(t)} turns · {t.minutes}m
          </Foot>
        </>
      )}
    </Frame>
  );
}

/** An agent with nothing live: a quiet card that opens the agent page. */
export function IdleCard({
  agent,
  go,
}: {
  agent: V3Agent;
  go: V3PageProps["go"];
}) {
  return (
    <Frame onOpen={() => go({ page: "agent", id: agent.id })}>
      <Head agent={agent} pill={<ThreadPill status="idle" />} />
      <div className="font-semibold text-[14.5px] leading-[1.35]">
        {agent.next ?? agent.role}
      </div>
      <div className="text-[13px] text-muted-foreground leading-normal">
        Asleep. {agent.schedule}.
      </div>
    </Frame>
  );
}
