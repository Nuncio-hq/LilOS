import {
  Message,
  MessageContent,
  MessageResponse,
} from "../components/ai-elements/message";
import { Badge } from "../components/ui/badge";
import { withFileMentionChips } from "../lib/mentions";
import { cn } from "../lib/utils";
import { HermesAvatar, HumanAvatar } from "../shell/avatars";
import type { EmpFn, HumanFn } from "../types";

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
        "lilos-rise group relative mx-1.5 grid grid-cols-[36px_minmax(0,1fr)] gap-3 rounded-2xl px-3 py-2 transition-colors hover:bg-foreground/[0.035] sm:mx-2 sm:px-4",
        active && "bg-primary/7 hover:bg-primary/7",
      )}
    >
      {emp(from) ? (
        <HermesAvatar name={emp(from)!.name} />
      ) : human(from) ? (
        <HumanAvatar human={human(from)!} />
      ) : null}
      <Message
        from="assistant"
        className={cn(
          "min-w-0 max-w-full gap-1",
          // Avatar-less rows (system notices) keep the content column — the
          // first grid child would otherwise collapse into the 36px gutter.
          !(emp(from) || human(from)) && "col-start-2",
        )}
      >
        {children}
      </Message>
    </div>
  );
}

export function Body({ text }: { text: string }) {
  return (
    <MessageContent className="w-full">
      <MessageResponse className="lilos-prose compact break-words">
        {withFileMentionChips(text)}
      </MessageResponse>
    </MessageContent>
  );
}
