import { Pulse } from "@lilos/ui-native/v3";
import { useStore } from "@nanostores/react";
import { CEO_THREAD_ID, personOf, STATUS_WORDS } from "../model";
import { openThread } from "../nav";
import { $data } from "../store";
import { ceoState, ticketsMoving } from "./home-model";

/* The tab bar's bottom accessory. The native bar renders its content twice
   (above the bar and beside the minimized one), so all state comes from the
   store and nothing is local. */
export function PulseAccessory({
  placement,
}: {
  placement: "regular" | "inline";
}) {
  const d = useStore($data);
  if (!d.ceoId) return null;
  const state = ceoState(d);
  return (
    <Pulse
      placement={placement}
      person={personOf(d, d.ceoId)}
      state={state}
      stateWord={STATUS_WORDS[state].toLowerCase()}
      detail={ticketsMoving(d)}
      onPress={() => openThread(CEO_THREAD_ID)}
    />
  );
}
