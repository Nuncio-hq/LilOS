import { formatDiagnostics, toStatusComponents } from "@lilos/client-runtime";
import { StatusDialog, V3Banner } from "@lilos/ui";
import { useMemo, useState } from "react";
import { useAtom } from "../lib/hooks";
import { relay } from "../lib/runtime";

/* What the old sidebar's status row said, as a line above the page: the relay
   unreachable or reconnecting, a fatal handshake (version mismatch, bad
   token), or a leg of system.status (harness, engine, model) down. Drawn only
   while something is wrong; "Details" opens the diagnostics the status dialog
   copies. A leg that is only waiting on the relay (blocked) is never named,
   the relay row already says why. */
export function StatusBanner() {
  const connection = useAtom(relay.state);
  const poll = useAtom(relay.status);
  const fatal = useAtom(relay.fatal);
  const [details, setDetails] = useState(false);
  const rows = useMemo(
    () => toStatusComponents({ result: poll.result, connection, fatal }),
    [poll.result, connection, fatal],
  );
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
    <>
      <V3Banner
        status={worst.state === "down" ? "failed" : "waiting"}
        text={text}
        action={{ label: "Details", run: () => setDetails(true) }}
      />
      {details && (
        <StatusDialog
          components={rows}
          diagnostics={formatDiagnostics({
            result: poll.result,
            connection,
            fatal,
            error: poll.error,
            app: { name: "LilOS" },
          })}
          onClose={() => setDetails(false)}
          onCopied={() => {}}
        />
      )}
    </>
  );
}
