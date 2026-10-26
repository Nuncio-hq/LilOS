import { ago, Section } from "./v3-bits";
import { AgentAvatar, StatusDot } from "./v3-marks";
import { agentOf, FORMER_AGENT, liveHelpersOf } from "./v3-model";
import { RowButton } from "./v3-open-record";
import type { V3PageProps } from "./v3-page-types";
import type { V3Thread } from "./v3-types";

/* "At work now" (D-#868): the running board on Home — one compact row of
   small cards, one per top-level thread mid-run, each the agent, its live
   step and its elapsed time, and Stop. Helpers have no card or row of
   their own (D-#847): the parent's card counts them ("+3 helpers"), so
   the strip stays one line tall and Needs you is still the first thing
   under it. Three cards at most — the rest sit behind "+N more", which
   lands on Threads with the Working fold open. On the phone the row
   scrolls sideways instead of growing down. Hidden when nothing runs. */

/** The most cards the strip draws before the "+N more" card. */
const CARDS = 3;

function WorkCard({ data, t, go, act }: V3PageProps & { t: V3Thread }) {
  const agent = agentOf(data, t.agentId);
  const helpers = liveHelpersOf(data, t.id).length;
  const step = t.now?.text ?? t.title;
  return (
    <RowButton
      opens={{ page: "thread", id: t.id }}
      onClick={() => go({ page: "thread", id: t.id })}
      className="mx-0 min-w-[180px] flex-1 rounded-xl border border-[var(--v3-line)] px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <AgentAvatar data={data} agent={agent} size={20} />
        <span className="min-w-0 flex-1 truncate font-medium text-[13px] text-foreground">
          {agent?.name ?? FORMER_AGENT}
        </span>
        {/* Stop acts on the thread; the card itself opens it. */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            act.stop(t.id);
          }}
          className="shrink-0 rounded px-1 text-[12.5px] text-muted-foreground hover:text-foreground"
        >
          Stop
        </button>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
        <StatusDot status={t.status} />
        <span className="min-w-0 truncate" title={step}>
          {step}
        </span>
        {/* Step text truncates; the elapsed and the helper count stay. */}
        <span className="shrink-0 tabular-nums text-muted-foreground/70">
          · {t.now?.elapsed ?? ago(t.minutes)}
        </span>
        {/* A card counts its helpers instead of drawing them (D-#847). */}
        {helpers > 0 && (
          <span className="ml-auto shrink-0 pl-1 text-[12px] text-muted-foreground/70">
            +{helpers} helper{helpers === 1 ? "" : "s"}
          </span>
        )}
      </div>
    </RowButton>
  );
}

/** `working` is Home's working section — top-level threads only, helpers
    are counted on their parent's card, never drawn. */
export function AtWorkNow({
  data,
  go,
  act,
  working,
}: V3PageProps & { working: V3Thread[] }) {
  if (working.length === 0) return null;
  const helpers = working.flatMap((t) => liveHelpersOf(data, t.id));
  const more = working.length - CARDS;
  return (
    <>
      <Section
        title="At work now"
        count={working.length + helpers.length}
        className="mt-6"
      />
      <div className="flex gap-2.5 overflow-x-auto pb-1">
        {working.slice(0, CARDS).map((t) => (
          <WorkCard key={t.id} data={data} t={t} go={go} act={act} />
        ))}
        {more > 0 && (
          <button
            type="button"
            onClick={() => go({ page: "threads", view: "working" })}
            className="flex min-w-[88px] shrink-0 items-center justify-center rounded-xl border border-[var(--v3-line)] border-dashed px-3 text-[12.5px] text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground"
          >
            +{more} more
          </button>
        )}
      </div>
    </>
  );
}
