import { MessageSquareIcon, TicketIcon } from "lucide-react";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "../components/ai-elements/message";
import { Badge } from "../components/ui/badge";
import { cn } from "../lib/utils";
import { HermesAvatar, HumanAvatar } from "../shell/avatars";
import type { EmpFn, HireDraft, HumanFn, Msg, Work } from "../types";
import { HireCardInline } from "./hire-card";
import { ThreadSummary } from "./thread-summary";

/* The name/time/badges line above a message. */
export function Who({
  id,
  time,
  emp,
  human,
}: {
  id: string;
  time: string;
  emp: EmpFn;
  human: HumanFn;
}) {
  const e = emp(id);
  const h = human(id);
  return (
    <div className="flex flex-wrap items-baseline gap-1.5">
      <span className="font-semibold">{e?.name ?? h?.name}</span>
      {e && (
        <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
          EMPLOYEE
        </Badge>
      )}
      {h?.guest && (
        <Badge
          variant="outline"
          className="h-4 border-amber-300 px-1.5 text-[10px] text-amber-700"
        >
          GUEST
        </Badge>
      )}
      <span className="text-muted-foreground text-xs">{time}</span>
    </div>
  );
}

/* One message row: avatar + content. */
export function Row({
  from,
  emp,
  human,
  active,
  children,
}: {
  from: string;
  emp: EmpFn;
  human: HumanFn;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "group relative grid grid-cols-[36px_minmax(0,1fr)] gap-3 px-3 py-2 hover:bg-muted/40 sm:px-5",
        active && "bg-blue-50/70 hover:bg-blue-50/70",
      )}
    >
      {emp(from) ? (
        <HermesAvatar />
      ) : human(from) ? (
        <HumanAvatar human={human(from)!} />
      ) : null}
      <Message from="assistant" className="min-w-0 max-w-full gap-1">
        {children}
      </Message>
    </div>
  );
}

export function Body({ text }: { text: string }) {
  return (
    <MessageContent className="w-full">
      <MessageResponse className="lilos-prose compact break-words">
        {text}
      </MessageResponse>
    </MessageContent>
  );
}

/* One ticket event line in the channel feed. */
export function EventRow({ ticket, text }: { ticket: string; text: string }) {
  return (
    <div className="grid grid-cols-[36px_minmax(0,1fr)] items-center gap-3 px-3 py-1.5 text-muted-foreground text-xs sm:px-5">
      <TicketIcon className="size-3.5 justify-self-center" />
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="shrink-0 whitespace-nowrap rounded bg-muted px-1.5 font-mono text-foreground">
          {ticket}
        </span>
        <span className="min-w-0">{text}</span>
      </div>
    </div>
  );
}

/* The whole channel timeline: messages (with optional hire card / thread summary) + ticket events.
   workOf is passed in: the app owns started-work state, the feed only renders it. */
export function FeedList({
  feed,
  emp,
  human,
  threadId,
  resolved,
  emptyText,
  workOf,
  onOpenThread,
  onReviewHire,
  onRejectHire,
  onSay,
}: {
  feed: Msg[];
  emp: EmpFn;
  human: HumanFn;
  threadId: string | null;
  resolved: Record<string, string>;
  emptyText: string;
  workOf: (m: Extract<Msg, { kind: "msg" }>) => Work | null;
  onOpenThread: (id: string) => void;
  onReviewHire: (draft: HireDraft) => void;
  onRejectHire: (id: string) => void;
  onSay: (t: string) => void;
}) {
  return (
    <>
      {feed.map((m) =>
        m.kind === "event" ? (
          <EventRow key={m.id} ticket={m.ticket} text={m.text} />
        ) : (
          <Row
            key={m.id}
            from={m.from}
            emp={emp}
            human={human}
            active={m.id === threadId}
          >
            <Who id={m.from} time={m.time} emp={emp} human={human} />
            <Body text={m.text} />
            {m.hire && (
              <HireCardInline
                draft={m.hire}
                by={m.from}
                emp={emp}
                done={resolved[m.id]}
                onReview={() => onReviewHire(m.hire!)}
                onReject={() => onRejectHire(m.id)}
              />
            )}
            {m.thread && (
              <ThreadSummary
                thread={m.thread}
                work={workOf(m)}
                emp={emp}
                onOpen={() => onOpenThread(m.id)}
              />
            )}
            {!m.thread && !m.hire && (
              <button
                onClick={() => onSay("Reply in thread (prototype)")}
                className="mt-1 hidden items-center gap-1 text-muted-foreground text-xs hover:text-foreground group-hover:inline-flex"
              >
                <MessageSquareIcon className="size-3.5" />
                Reply in thread
              </button>
            )}
          </Row>
        ),
      )}
      {feed.length === 0 && (
        <p className="px-5 py-10 text-center text-muted-foreground">
          {emptyText}
        </p>
      )}
    </>
  );
}
