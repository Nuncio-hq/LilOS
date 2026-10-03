import { Loader2Icon, TriangleAlertIcon, UnplugIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { ConnectionState } from "../types";

/* Slim notice under a DM header when the employee's profile isn't connected
   to LilOS (issue #338 AC-3): plain text plus a Connect action. "failed"
   appends the plain reason; "updating" shows progress and hides the action.
   The caller renders it only for non-connected states — "connected" means no
   notice at all. */
export function NotConnectedNotice({
  state,
  reason,
  onConnect,
}: {
  state: Exclude<ConnectionState, "connected">;
  /** Plain reason, shown after the notice text on "failed". */
  reason?: string;
  /** Connect action — the button renders only when passed (D-#19). */
  onConnect?: () => void;
}) {
  const failed = state === "failed";
  return (
    <div
      data-not-connected
      className={cn(
        "flex items-center gap-2 border-b px-3 py-1.5 text-xs sm:px-5",
        failed
          ? "border-red-200 bg-red-50/60 text-red-900 dark:border-red-900/50 dark:bg-red-950/30"
          : "border-amber-200 bg-amber-50/60 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200",
      )}
    >
      {state === "updating" ? (
        <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
      ) : failed ? (
        <TriangleAlertIcon className="size-3.5 shrink-0" />
      ) : (
        <UnplugIcon className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1">
        {state === "updating" ? (
          "Connecting to LilOS…"
        ) : (
          <>
            Not connected to LilOS: this employee can't see the app and may use
            its own browser.
            {failed && reason ? ` ${reason}` : ""}
          </>
        )}
      </span>
      {state !== "updating" && onConnect && (
        <Button
          size="sm"
          variant={failed ? "outline" : "default"}
          className="h-6 shrink-0 px-2 text-xs"
          onClick={onConnect}
        >
          Connect
        </Button>
      )}
    </div>
  );
}
