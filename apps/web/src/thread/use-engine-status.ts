import { toStatusComponents } from "@lilos/client-runtime";
import { useMemo } from "react";
import { useAtom } from "../lib/hooks";
import { relay } from "../lib/runtime";

/* AC-2 (#85): an engine that's down (Hermes missing, crashed out) shows its
   plain reason above the composer — never silently sendable. Employees read
   offline while it is (#99), so the thread and the DM home share this. */
export function useEngineStatus() {
  const statusPoll = useAtom(relay.status);
  const fatal = useAtom(relay.fatal);
  const engineRow = useMemo(
    () =>
      toStatusComponents({
        result: statusPoll.result,
        connection: statusPoll.connection,
        fatal,
      }).find((c) => c.id === "engine"),
    [statusPoll, fatal],
  );
  const engineDown = engineRow?.state === "down";
  const composerNote =
    engineDown && engineRow?.reason
      ? engineRow.hint
        ? `${engineRow.reason} ${engineRow.hint}`
        : engineRow.reason
      : undefined;
  return { statusPoll, engineDown, composerNote };
}
