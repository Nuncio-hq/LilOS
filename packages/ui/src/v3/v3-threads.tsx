import { PlusIcon } from "lucide-react";
import { Btn, Page, Title, useTick } from "./v3-bits";
import { useFoldPrefs } from "./v3-layout-prefs";
import { defaultAgent } from "./v3-model";
import type { V3PageProps } from "./v3-page-types";
import { ScheduledView } from "./v3-schedules";
import { sectionedThreads } from "./v3-sections";
import { Fold, ThreadRow } from "./v3-threads-rows";
import type { V3Thread } from "./v3-types";

/* Threads is one list by status (#887): Pinned, then what came back to
   you (Active, newest-back first), then the folded shelves — Working,
   Snoozed, Done. The tabs, the Group-by switch and the counters went away
   in #887; Scheduled still answers at its own URL (view=scheduled) for
   deep links. */

function ThreadList(p: V3PageProps) {
  const { data } = p;
  /* A wake time passing quietly returns its thread to Active; tick so the
     list re-reads the clock without waiting for a touch. */
  useTick(30_000);
  const s = sectionedThreads(data);
  const { folds, setFold } = useFoldPrefs();
  const row = (t: V3Thread) => <ThreadRow key={t.id} {...p} t={t} />;

  return (
    <div className="mt-3 text-[13.5px]">
      {s.pinned.length > 0 && (
        <>
          <div className="pt-1 pb-1 text-[12.5px] text-muted-foreground/70">
            Pinned
          </div>
          {s.pinned.map(row)}
        </>
      )}
      {s.active.length > 0 && (
        <>
          <div className="pt-2.5 pb-1 text-[12.5px] text-muted-foreground/70">
            Active
          </div>
          {s.active.map(row)}
        </>
      )}
      <Fold
        title="Working"
        count={s.working.length}
        open={folds.working === true}
        onToggle={(o) => setFold("working", o)}
        marker="working"
      >
        {s.working.map(row)}
      </Fold>
      <Fold
        title="Snoozed"
        count={s.snoozed.length}
        open={folds.snoozed === true}
        onToggle={(o) => setFold("snoozed", o)}
        marker="snoozed"
      >
        {s.snoozed.map(row)}
      </Fold>
      <Fold
        title="Done"
        count={s.settled.length}
        open={folds.settled === true}
        onToggle={(o) => setFold("settled", o)}
        marker="settled"
      >
        <div data-settled-list>
          {s.settled.map((t) => (
            <ThreadRow key={t.id} {...p} t={t} settled />
          ))}
        </div>
      </Fold>
    </div>
  );
}

export function V3Threads(props: V3PageProps & { view?: "scheduled" }) {
  const { view, go, data } = props;
  const starter = defaultAgent(data);
  return (
    <Page wide>
      <Title>Threads</Title>
      <p className="-mt-1 text-[15px] text-muted-foreground">
        Every agent thread, live.
      </p>
      {starter && (
        <div className="mt-4 flex justify-end">
          <Btn
            primary
            small
            onClick={() => go({ page: "newchat", id: starter.id })}
          >
            <PlusIcon /> New chat
          </Btn>
        </div>
      )}
      {view === "scheduled" ? (
        <ScheduledView {...props} />
      ) : (
        <ThreadList {...props} />
      )}
    </Page>
  );
}
