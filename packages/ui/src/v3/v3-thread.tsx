import { SquareIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { Btn, Kbd, Spinner, StatusPill, Title, useTick } from "./v3-bits";
import { elapsedAt, OutLine, streamTail, ThreadPill } from "./v3-live";
import { agentOf } from "./v3-model";
import { ThreadRail } from "./v3-thread-rail";
import { Turns } from "./v3-thread-turns";
import type { V3PageProps, V3Thread } from "./v3-types";

/* One thread: the live block on top, turns below, context on the right. */

const OUT_LINES = 6;

const turnsOf = (t: V3Thread) => t.turns.reduce((m, x) => Math.max(m, x.n), 0);

function Box({ children, bad }: { children: ReactNode; bad?: boolean }) {
  return (
    <div
      className={cn(
        "mt-5 rounded-[10px] border px-4 pt-3.5 pb-4",
        bad
          ? "border-red-200 bg-red-50/60 dark:border-red-400/25 dark:bg-red-400/8"
          : "border-[var(--v3-line)]",
      )}
    >
      {children}
    </div>
  );
}

function StopBtn({ onClick }: { onClick: () => void }) {
  return (
    <Btn small onClick={onClick} title="Stop (⌘.)" className="ml-auto gap-1.5">
      <SquareIcon className="size-3 fill-current" />
      Stop
    </Btn>
  );
}

/** Working: the command and its output, arriving line by line. */
function LiveBox({ t, onStop }: { t: V3Thread; onStop: () => void }) {
  const n = useTick(1000);
  const live = t.live;
  const lines = live?.lines ?? [];
  // `--repeat-each=N` commands replay their recorded runs until N are done;
  // other commands reveal each recorded line once and then wait.
  const repeat = Number(/--repeat-each=(\d+)/.exec(live?.cmd ?? "")?.[1] ?? 0);
  const perRun = Math.max(1, lines.filter((l) => l.includes("(run 1)")).length);
  const total = repeat || lines.length;
  const cap = repeat ? repeat * perRun : lines.length;
  const count = Math.min(
    cap,
    Math.min(lines.length, repeat ? 4 : 1) + Math.floor(n / 2),
  );
  const shown = streamTail(lines, count, OUT_LINES - 1);
  const done = repeat ? Math.ceil(count / perRun) : count;

  return (
    <Box>
      <div className="flex items-center gap-2 text-[13.5px] text-muted-foreground">
        <Spinner />
        <b className="font-semibold text-foreground">Working</b>
        <span>
          · turn {turnsOf(t)} · step {t.step} ·{" "}
          {t.now ? elapsedAt(t.now.elapsed, n) : `${t.minutes}m`}
        </span>
        <StopBtn onClick={onStop} />
      </div>
      {live && (
        <>
          <div className="mt-2.5 mb-2 break-all font-mono text-[12.5px]">
            {live.cmd}
          </div>
          <div className="overflow-hidden rounded-[7px] bg-[var(--v3-soft)] px-3 py-2 font-mono text-[12px] text-muted-foreground leading-[1.7]">
            {shown.map((l) => (
              <div key={l.key} className="lilos-v3-line-in truncate">
                <OutLine text={l.text} />
              </div>
            ))}
            <div className="truncate">
              Running {done} of {total}…
            </div>
          </div>
        </>
      )}
    </Box>
  );
}

export function V3ThreadPage(props: V3PageProps & { id: string }) {
  const t = props.data.threads.find((x) => x.id === props.id);
  if (!t) {
    return (
      <div className="mx-auto w-full max-w-[740px] px-8 pt-10 text-[14px]">
        <Title>Thread not found</Title>
        <button
          type="button"
          onClick={() => props.go({ page: "threads", view: "live" })}
          className="text-muted-foreground hover:text-foreground"
        >
          ← Back to Threads
        </button>
      </div>
    );
  }
  return <ThreadBody {...props} t={t} />;
}

function ThreadBody({ data, go, act, t }: V3PageProps & { t: V3Thread }) {
  const agent = agentOf(data, t.agentId);
  const [draft, setDraft] = useState("");
  const working = t.status === "working";
  const ask = t.askId ? data.asks.find((a) => a.id === t.askId) : undefined;
  const handTo = agentOf(data, "marketer");

  const { markSeen } = act;
  useEffect(() => {
    if (t.unseen) markSeen(t.id);
  }, [t.unseen, t.id, markSeen]);

  // ⌘. stops a working thread, wherever the focus is.
  const { stop } = act;
  useEffect(() => {
    if (!working) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault();
        stop(t.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [working, stop, t.id]);

  const send = (e: KeyboardEvent<HTMLInputElement>) => {
    const text = draft.trim();
    if (e.key !== "Enter" || e.nativeEvent.isComposing || !text) return;
    act.message(t.id, text);
    setDraft("");
  };

  return (
    <div className="mx-auto grid w-full max-w-[920px] grid-cols-[minmax(0,1fr)_232px] gap-12 px-8 pt-8 pb-24 max-[860px]:grid-cols-1">
      <div className="min-w-0">
        <div className="mb-2 text-[13.5px] text-muted-foreground">
          Thread · {agent.name} on{" "}
          <button
            type="button"
            onClick={() => go({ page: "ticket", id: t.ticketId })}
            className="hover:text-foreground hover:underline"
          >
            {t.ticketId}
          </button>
        </div>
        <Title small>{t.title}</Title>
        <div className="flex items-center gap-2.5 text-[13.5px] text-muted-foreground">
          <ThreadPill status={t.status} />
          Started {t.startedAt} · {turnsOf(t)}{" "}
          {turnsOf(t) === 1 ? "turn" : "turns"} · {t.minutes}m
        </div>

        {working && <LiveBox t={t} onStop={() => act.stop(t.id)} />}

        {t.status === "needs" && (
          <Box>
            <div className="flex items-center gap-2 text-[13.5px]">
              <StatusPill status="needs" />
              <span className="text-muted-foreground">
                Waiting {ask?.waiting ?? 0}m for you
              </span>
            </div>
            <p className="mt-2.5 text-[14px] leading-normal">
              {t.quote ?? ask?.ask}
            </p>
            {t.askId && (
              <div className="mt-3 flex gap-2">
                <Btn small onClick={() => act.deny(t.askId as string)}>
                  Deny
                </Btn>
                <Btn
                  small
                  primary
                  onClick={() => act.approve(t.askId as string)}
                >
                  Approve
                </Btn>
              </div>
            )}
          </Box>
        )}

        {t.status === "stuck" && (
          <Box bad>
            <div className="flex items-center gap-2 text-[13.5px]">
              <StatusPill status="stuck" />
              <b className="font-semibold text-red-700 dark:text-red-300">
                {t.stuck?.what}
              </b>
              {t.now && (
                <span className="text-red-600/80 dark:text-red-300/80">
                  · {t.now.elapsed}
                </span>
              )}
            </div>
            <div className="mt-2.5 rounded-[7px] bg-background/70 px-3 py-2 font-mono text-[12px] text-muted-foreground leading-[1.7]">
              {t.stuck?.detail.map((d) => (
                <div key={d}>{d}</div>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <Btn small onClick={() => act.stop(t.id)}>
                Stop
              </Btn>
              <Btn small onClick={() => act.handOff(t.ticketId, handTo.id)}>
                Hand to {handTo.name}
              </Btn>
            </div>
          </Box>
        )}

        {t.status === "done" && (
          <div className="mt-5 text-[13.5px] text-muted-foreground">
            <b className="font-medium text-foreground">Finished</b> · took{" "}
            {t.minutes}m
            {t.quote && (
              <p className="mt-1.5 text-[14px] text-foreground leading-normal">
                “{t.quote}”
              </p>
            )}
          </div>
        )}

        <Turns turns={t.turns} />

        <div className="mt-7 flex items-center gap-2.5 rounded-[10px] border border-foreground/15 px-3.5 py-2.5 text-[14px]">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={send}
            placeholder={`Message ${agent.name}… it reads this after the current step`}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/70"
          />
          <Kbd className="ml-auto">⌘. to stop</Kbd>
        </div>
      </div>

      <ThreadRail t={t} agent={agent} go={go} />
    </div>
  );
}
