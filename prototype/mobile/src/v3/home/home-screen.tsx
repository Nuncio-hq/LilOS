import { threadsIn } from "@lilos/ui/v3-data";
import { HomeScreen } from "@lilos/ui-native/v3";
import { useStore } from "@nanostores/react";
import { useMemo } from "react";
import { hapticApprove, hapticDeny, hapticSelect } from "../haptics";
import { askVM, CEO_THREAD_ID, openAsks, personOf, resultRows } from "../model";
import { openAgent, openTab, openThread, openTicket } from "../nav";
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
  return (
    <HomeScreen
      counts={{
        working: threadsIn(d.threads, "working"),
        needs: d.asks.length,
        stuck: threadsIn(d.threads, "stuck"),
      }}
      hero={hero}
      moreAsks={Math.max(0, asks.length - 1)}
      update={update}
      team={team}
      results={results}
      /* Stuck threads show on Work's default view, like working ones. */
      onOpenCount={(key) => openTab(key === "needs" ? "Needs" : "Work")}
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
      onOpenNeeds={() => openTab("Needs")}
      onOpenUpdate={() => openThread(CEO_THREAD_ID)}
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
