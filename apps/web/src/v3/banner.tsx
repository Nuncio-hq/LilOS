import { formatDiagnostics, toStatusComponents } from "@lilos/client-runtime";
import { StatusDialog, V3Banner } from "@lilos/ui";
import { atom } from "nanostores";
import { useMemo } from "react";
import { useAtom } from "../lib/hooks";
import { relay } from "../lib/runtime";

/* What the old sidebar's status row said, as a line above the page: the relay
   unreachable or reconnecting, a fatal handshake (version mismatch, bad
   token), or a leg of system.status (harness, engine, model) down. Drawn only
   while something is wrong; "Details" opens the diagnostics the status dialog
   copies. A leg that is only waiting on the relay (blocked) is never named,
   the relay row already says why. */

/** Whether the system status dialog is open. The banner's Details and first
    run's "See status" open the same one, so it lives outside both. */
const statusOpen = atom(false);

/** Opens the system status dialog (`showStatus` on the shell's actions). */
export const openStatus = (): void => statusOpen.set(true);

/** The relay's last answer as the status dialog's rows. */
function useStatusRows() {
  const connection = useAtom(relay.state);
  const poll = useAtom(relay.status);
  const fatal = useAtom(relay.fatal);
  const rows = useMemo(
    () => toStatusComponents({ result: poll.result, connection, fatal }),
    [poll.result, connection, fatal],
  );
  return { rows, connection, poll, fatal };
}

export function StatusBanner() {
  const { rows, connection, poll, fatal } = useStatusRows();
  // Connected but not polled yet is boot, not trouble.
  const booting = !poll.result && connection === "ready" && !fatal;
  const worst =
    rows.find((r) => r.state === "down") ??
    rows.find((r) => r.state === "connecting" || r.state === "degraded");
  if (booting || !worst) return null;
  const text = [worst.reason || `${worst.label} is ${worst.state}.`, worst.hint]
    .filter(Boolean)
    .join(" ");
  return (
    <V3Banner
      status={worst.state === "down" ? "failed" : "waiting"}
      text={text}
      action={{ label: "Details", run: openStatus }}
    />
  );
}

/** The system status dialog, over whatever is on screen (first run included,
    where no banner is drawn). */
export function StatusDetails() {
  const open = useAtom(statusOpen);
  const { rows, connection, poll, fatal } = useStatusRows();
  if (!open) return null;
  return (
    <StatusDialog
      components={rows}
      diagnostics={formatDiagnostics({
        result: poll.result,
        connection,
        fatal,
        error: poll.error,
        app: { name: "LilOS" },
      })}
      onClose={() => statusOpen.set(false)}
      onCopied={() => {}}
    />
  );
}
