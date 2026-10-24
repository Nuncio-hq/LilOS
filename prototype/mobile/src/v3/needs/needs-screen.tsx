import { agentStatus } from "@lilos/ui/v3-data";
import { NeedsScreen } from "@lilos/ui-native/v3";
import { useStore } from "@nanostores/react";
import { useEffect, useMemo, useState } from "react";
import { hapticApprove, hapticDeny, hapticSelect } from "../haptics";
import { askVM, openAsks, resultRows } from "../model";
import { openThread, openTicket } from "../nav";
import { $data, $focusAsk, answer, approve, deny, markSeen } from "../store";

/** The Needs you tab: one decision at a time, then what finished. */
export function NeedsContainer() {
  const d = useStore($data);
  const focus = useStore($focusAsk);
  // A notification tap brings its ask to the front; it stays there until it
  // is decided, so the stack does not reshuffle under the reader.
  const [lead, setLead] = useState<string>();
  useEffect(() => {
    if (!focus) return;
    setLead(focus);
    $focusAsk.set(undefined);
  }, [focus]);

  const open = useMemo(() => openAsks(d), [d]);
  const { asks, position } = useMemo(() => {
    const first = open.find((a) => a.id === lead);
    const ordered = first ? [first, ...open.filter((a) => a !== first)] : open;
    return {
      asks: ordered.map((a) => askVM(d, a)),
      position: ordered[0] ? open.indexOf(ordered[0]) + 1 : 1,
    };
  }, [d, open, lead]);

  const { rows, vms: results } = useMemo(() => resultRows(d), [d]);

  const working = useMemo(
    () => d.agents.filter((a) => agentStatus(d, a.id) === "working").length,
    [d],
  );
  const emptyBody =
    working === 0
      ? "Nothing waits on you. Everyone is idle."
      : `Nothing waits on you. ${working} ${working === 1 ? "agent is" : "agents are"} working.`;

  return (
    <NeedsScreen
      asks={asks}
      position={position}
      emptyBody={emptyBody}
      results={results}
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
      onOpenThread={openThread}
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
