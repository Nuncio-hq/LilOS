import type { SessionListRow } from "@lilos/ui-native";
import { SessionsScreen } from "@lilos/ui-native";
import { useMemo } from "react";
import { toSessionGroups } from "../home-model";
import type { Props } from "../routes";
import { useHomeWire, useNowMs } from "./home";

/* Every session across employees — needs you / working / recently finished
   (unread first). A row pushes the thread with its DM underneath, the same
   landing an ask's Open takes. */
export function Sessions({ navigation }: Props<"Sessions">) {
  const { wire } = useHomeWire();
  const nowMs = useNowMs();
  const groups = useMemo(() => toSessionGroups(wire, nowMs), [wire, nowMs]);
  const open = (r: SessionListRow) => {
    navigation.navigate("Dm", { employeeId: r.employeeId });
    navigation.navigate("Thread", {
      conversationId: r.id,
      employeeId: r.employeeId,
    });
  };
  return <SessionsScreen groups={groups} onOpen={open} />;
}
