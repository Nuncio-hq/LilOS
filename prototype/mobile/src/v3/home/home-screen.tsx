import { threadsIn } from "@lilos/ui/v3-data";
import { HomeScreen } from "@lilos/ui-native/v3";
import { useStore } from "@nanostores/react";
import { useMemo } from "react";
import { hapticApprove, hapticDeny, hapticSelect } from "../haptics";
import { askVM, openAsks, personOf, resultRows, updateTarget } from "../model";
import { openAgent, openTab, openTarget, openThread, openTicket } from "../nav";
import { $data, answer, approve, deny, markSeen } from "../store";
import { teamPeople } from "./home-model";

export function HomeContainer() {
  const d = useStore($data);
  const asks = useMemo(() => openAsks(d), [d]);
  const hero = useMemo(
    () => (asks[0] ? askVM(d, asks[0]) : undefined),
    [d, asks],
  );
  const team = useMemo(() => teamPeople(d), [d]);
  const { rows, vms: results } = useMemo(() => resultRows(d), [d]);
  const latest = d.updates[0];
  const update =
    d.features.tickets && d.ceoId && latest
      ? { by: personOf(d, latest.by), at: latest.at, text: latest.text }
      : undefined;
  const target = latest && updateTarget(d, latest);
  const working = threadsIn(d.threads, "working");
  const stuck = d.threads.filter((t) => t.status === "stuck");
  return (
    <HomeScreen
      counts={{ working, needs: d.asks.length, stuck: stuck.length }}
      hero={hero}
      update={update}
      team={team}
      results={results}
      /* Every tile opens something different, or nothing. Needs you: its tab.
         Stuck: the thread when it is one, else Work, whose first module is
         what is stuck. Working has no tile destination: the Team strip right
         below already shows who is working, and Work would be the same place
         as Stuck's. */
      onOpenCount={{
        needs: () => openTab("Needs"),
        stuck: stuck[0]
          ? () =>
              stuck.length === 1 && stuck[0]
                ? openThread(stuck[0].id)
                : openTab("Work")
          : undefined,
      }}
      onApprove={(id) => {
        hapticApprove();
        approve(id);
      }}
      onDeny={(id) => {
        hapticDeny();
        deny(id);
      }}
      onAnswer={(id, option) => {
        hapticSelect();
        answer(id, option);
      }}
      onReviewPlan={openThread}
      onOpenUpdate={target ? () => openTarget(target) : undefined}
      onOpenTeam={() => openTab("Company")}
      onOpenAgent={openAgent}
      onOpenResult={(key) => {
        const row = rows.find((r) => r.key === key);
        if (!row) return;
        if (row.threadId) {
          markSeen(row.threadId);
          openThread(row.threadId);
        } else if (row.ticketId) openTicket(row.ticketId);
      }}
    />
  );
}
