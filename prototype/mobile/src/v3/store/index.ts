import { resetClock } from "./clock";
import { clearLanes } from "./lanes";
import { resetQueue } from "./queue";
import { seed } from "./seed";
import { $data, $focusAsk } from "./state";

export { answer, approve, deny } from "./asks";
export { askCeo, sendMessage } from "./chat";
export { hire } from "./people";
export { queuedCount, type Released, releaseNext } from "./queue";
export { $data, $focusAsk, focusAsk, markSeen } from "./state";

/** Back to the seed company: timers stopped, the demo queue refilled, the
    clock restarted. The deep link `lilos://preview?reset=1` calls it. */
export function resetCompany(): void {
  clearLanes();
  resetQueue();
  resetClock();
  $focusAsk.set(undefined);
  $data.set(seed());
}
