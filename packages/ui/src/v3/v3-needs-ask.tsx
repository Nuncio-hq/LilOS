import { cn } from "../lib/utils";
import { ago, Btn, Meter } from "./v3-bits";
import type { V3Ask, V3Data } from "./v3-data-types";
import { AgentAvatar, CeoMark, StatusPill } from "./v3-marks";
import {
  agentOf,
  askTag,
  companyOn,
  FORMER_AGENT,
  goalOf,
  ticketOf,
} from "./v3-model";
import type { V3PageProps, V3Route } from "./v3-page-types";

/* The open ask on the Needs you page: the card with its four answers (ask,
   why, yes, no), the spend meter and the CEO's default. Kept apart from the
   page so the list logic and this card each stay readable on their own. */

/** The CEO's-default chip; the open card and the list rows share it. */
export const CHIP =
  "inline-flex shrink-0 items-center rounded-[10px] bg-yellow-50 px-[9px] py-px font-medium text-[12.5px] text-yellow-700 dark:bg-yellow-400/12 dark:text-yellow-300";

export function OpenAsk({
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
  /* With the company layer paused (D-#836) the ticket and goal behind an
     ask are records the page cannot open: the ask's own thread is where it
     lives then, and the CEO's default stays unannounced. */
  const company = companyOn(data);
  const ticket =
    company && ask.ticketId ? ticketOf(data, ask.ticketId) : undefined;
  const goal = ticket?.goalId ? goalOf(data, ticket.goalId) : undefined;
  const isQuestion = ask.kind === "question";
  // A missing line is not a row. Hide "The ask" when it repeats the title.
  const rows: [string, string | undefined, boolean?][] = [
    ["The ask", ask.ask === ask.title ? undefined : ask.ask],
    ["Why", ask.why],
    [isQuestion ? "If yes" : "If you approve", ask.ifYes],
    [isQuestion ? "If no" : "If you deny", ask.ifNo, true],
  ];
  // Without a ticket the ask lives in the chat it was raised in.
  const opens: { label: string; to: V3Route } | undefined =
    company && ask.ticketId
      ? { label: "Open ticket", to: { page: "ticket", id: ask.ticketId } }
      : ask.threadId
        ? { label: "Open thread", to: { page: "thread", id: ask.threadId } }
        : undefined;

  return (
    <div className="my-3 mb-1 rounded-[10px] border border-[var(--v3-line)] px-[18px] pt-4 pb-3.5">
      <div className="flex items-baseline gap-2.5 font-semibold text-[17px] text-foreground">
        <span className="font-normal text-[14px] text-muted-foreground/70">
          {askTag(data, ask)}
        </span>
        {ask.title}
        <StatusPill status="needs" className="ml-auto self-center" />
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-[13px] text-muted-foreground">
        <AgentAvatar data={data} agent={from} size={18} />
        {/* One text run, so it reads "Default asks", not "Defaultasks": the
           flex gap spaces it on screen but not for a screen reader. */}
        <span>
          {from?.name ?? FORMER_AGENT}
          {from?.id === data.ceoId && (
            <>
              {" "}
              <CeoMark />
            </>
          )}{" "}
          asks · waiting {ago(ask.waiting)}
          {goal && ` · goal ${goal.title}`}
        </span>
      </div>

      <div className="mt-4 mb-1 grid grid-cols-[120px_1fr] gap-x-3.5 gap-y-[9px] text-[14px] leading-[1.5]">
        {rows.map(([k, v, quiet]) =>
          v === undefined ? null : (
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
          ),
        )}
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

      {/* #884: the full payload behind the sentence — the same Details the
          thread card shows, so an approval can be inspected without opening
          the thread. Opens itself when it had to clip or could do harm. */}
      {ask.details && (
        <details
          data-approval-details
          open={ask.detailsOpen === true}
          className="mt-3"
        >
          <summary className="cursor-pointer select-none text-[12.5px] text-muted-foreground/80 hover:text-foreground">
            Details
          </summary>
          <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-foreground/[0.04] p-2.5 font-mono text-[12px] leading-normal text-foreground/90">
            {ask.details}
          </pre>
        </details>
      )}

      {company && ask.fallback && (
        <div className="mt-3 flex">
          <span className={CHIP}>
            If you don't answer by {ask.fallback.at}: the CEO{" "}
            {ask.fallback.does}
          </span>
        </div>
      )}

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
          {opens && <Btn onClick={() => go(opens.to)}>{opens.label}</Btn>}
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
                Allow{ask.spend ? ` $${ask.spend.amount}` : ""}
              </Btn>
            </>
          )}
        </span>
      </div>
    </div>
  );
}
