import { Fragment } from "react";
import { cn } from "../lib/utils";
import { ago, Btn, Section } from "./v3-bits";
import { AgentAvatar, StatusDot } from "./v3-marks";
import { agentOf, FORMER_AGENT, liveHelpersOf } from "./v3-model";
import { RowButton } from "./v3-open-record";
import type { V3PageProps } from "./v3-page-types";
import type { V3Thread } from "./v3-types";

/* "At work now" (D-#868): the running board on Home — every thread mid-run
   and the helpers inside it, each with its live step, how long it has run
   and Stop. Working rows live HERE, not in Home's one list (#862): the
   strip is the glance at who is on the job; the list stays needs-you →
   recent, so a working thread shows once. Hidden when nothing runs. */

function WorkRow({
  data,
  t,
  go,
  act,
  nested,
}: V3PageProps & { t: V3Thread; nested?: boolean }) {
  const agent = agentOf(data, t.agentId);
  return (
    <RowButton
      opens={{ page: "thread", id: t.id }}
      onClick={() => go({ page: "thread", id: t.id })}
      className={cn(
        "flex min-h-[38px] items-center gap-2.5 border-[var(--v3-line)] border-b py-1.5 text-[13.5px]",
        nested && "pl-7",
      )}
    >
      <StatusDot status={t.status} />
      <span className="flex shrink-0 items-center gap-1.5 font-medium text-foreground">
        <AgentAvatar data={data} agent={agent} size={16} />
        {agent?.name ?? FORMER_AGENT}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-muted-foreground"
        title={t.title}
      >
        {t.now?.text ?? t.title}
      </span>
      <span
        className="shrink-0 tabular-nums text-muted-foreground/70"
        title={`Running ${ago(t.minutes)}`}
      >
        {ago(t.minutes)}
      </span>
      {/* Stop acts on the thread; the row itself opens it. */}
      <span
        className="shrink-0"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Btn small onClick={() => act.stop(t.id)}>
          Stop
        </Btn>
      </span>
    </RowButton>
  );
}

/** `working` is Home's working section (already free of helper rows — they
    draw nested under their parent here instead, per D-#847). */
export function AtWorkNow({
  data,
  go,
  act,
  working,
}: V3PageProps & { working: V3Thread[] }) {
  if (working.length === 0) return null;
  const helpers = working.flatMap((t) => liveHelpersOf(data, t.id));
  return (
    <>
      <Section title="At work now" count={working.length + helpers.length} />
      <div className="border-[var(--v3-line)] border-t">
        {working.map((t) => (
          <Fragment key={t.id}>
            <WorkRow data={data} t={t} go={go} act={act} />
            {liveHelpersOf(data, t.id).map((h) => (
              <WorkRow key={h.id} data={data} t={h} go={go} act={act} nested />
            ))}
          </Fragment>
        ))}
      </div>
    </>
  );
}
