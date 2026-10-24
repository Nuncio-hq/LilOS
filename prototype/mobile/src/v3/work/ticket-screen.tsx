import { ticketOf } from "@lilos/ui/v3-data";
import { TicketScreen } from "@lilos/ui-native/v3";
import { useStore } from "@nanostores/react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useMemo } from "react";
import { hapticApprove, hapticDeny } from "../haptics";
import { openAgent, openThread, type RootRoutes } from "../nav";
import { $data, answer, approve, deny, markSeen } from "../store";
import { ticketPageVM } from "./ticket-page";

/** A ticket's own page, pushed inside its tab's stack. The stack's header says
    its id; the page's header card carries the title. */
export function TicketContainer({
  route,
}: NativeStackScreenProps<RootRoutes, "Ticket">) {
  const { ticketId } = route.params;
  const d = useStore($data);
  const page = useMemo(() => {
    const t = ticketOf(d, ticketId);
    return t ? ticketPageVM(d, t) : undefined;
  }, [d, ticketId]);

  return (
    <TicketScreen
      page={page}
      onOpenAgent={openAgent}
      onOpenThread={(id) => {
        markSeen(id);
        openThread(id);
      }}
      onApprove={(askId) => {
        hapticApprove();
        approve(askId);
      }}
      onDeny={(askId) => {
        hapticDeny();
        deny(askId);
      }}
      onAnswer={(askId, option) => {
        hapticApprove();
        answer(askId, option);
      }}
    />
  );
}
