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
      update={update}
      team={team}
      results={results}
      onOpenCount={(key) => {
        if (key === "needs") return openTab("Needs");
        // One stuck thread is the thing to look at: open it. Working and
        // several stuck go to Work, which lists them.
        const stuck = d.threads.filter((t) => t.status === "stuck");
        if (key === "stuck" && stuck.length === 1 && stuck[0])
          return openThread(stuck[0].id);
        openTab("Work");
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
