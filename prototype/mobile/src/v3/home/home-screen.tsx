import { threadsIn } from "@lilos/ui/v3-data";
import { type AskVM, HomeScreen } from "@lilos/ui-native/v3";
import { useStore } from "@nanostores/react";
import { useMemo } from "react";
import { hapticApprove, hapticDeny } from "../haptics";
import { askVM, CEO_THREAD_ID, openAsks, personOf } from "../model";
import { openAgent, openTab, openThread } from "../nav";
import { $data, approve, deny, focusAsk } from "../store";
import { teamRows } from "./home-model";

/** The asks that fit on Home; the rest is one tap away in Needs. */
const TOP_ASKS = 2;

export function HomeContainer() {
  const d = useStore($data);
  const asks = useMemo<AskVM[]>(
    () =>
      openAsks(d)
        .slice(0, TOP_ASKS)
        .map((a) => askVM(d, a)),
    [d],
  );
  const team = useMemo(() => teamRows(d), [d]);
  const latest = d.updates[0];
  const update =
    d.features.tickets && d.ceoId && latest
      ? { by: personOf(d, latest.by), at: latest.at, text: latest.text }
      : undefined;
  return (
    <HomeScreen
      title={d.company}
      date={d.today}
      update={update}
      counts={{
        working: threadsIn(d.threads, "working"),
        needs: d.asks.length,
        stuck: threadsIn(d.threads, "stuck"),
      }}
      asks={asks}
      team={team}
      onOpenUpdate={() => openThread(CEO_THREAD_ID)}
      /* Stuck threads show on Work's default view, like working ones. */
      onOpenCount={(key) => openTab(key === "needs" ? "Needs" : "Work")}
      onOpenAsk={(id) => {
        focusAsk(id);
        openTab("Needs");
      }}
      onApprove={(id) => {
        hapticApprove();
        approve(id);
      }}
      onDeny={(id) => {
        hapticDeny();
        deny(id);
      }}
      onOpenAgent={openAgent}
    />
  );
}
