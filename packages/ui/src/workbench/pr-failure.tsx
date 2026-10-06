import { ChevronRightIcon, CircleAlertIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import type { PrError } from "../types";

/* The PR tab's `gh`-failed state: plain copy per reason + one next step, the
   raw stderr only behind Details — never the headline (#114 AC-5).
   #579 AC-2: no copy may ask for a typed command — each names a step the
   user can take (ask the employee, then Retry). */
export function PrFailure({
  error,
  onRetry,
  employeeName = "the employee",
}: {
  error: PrError;
  onRetry?: () => void;
  /** Named in the ask-the-employee next step (#579). */
  employeeName?: string;
}) {
  return (
    <>
      <CircleAlertIcon className="size-5" />
      {error.reason === "missing" ? (
        <p>
          GitHub CLI isn't installed on this machine. Ask {employeeName} to
          install it, then Retry.
        </p>
      ) : error.reason === "unauthenticated" ? (
        <p>
          GitHub isn't signed in on this machine. Ask {employeeName} to sign in,
          then Retry.
        </p>
      ) : (
        <p>Couldn't load the PR.</p>
      )}
      {onRetry && (
        <Button size="xs" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      )}
      {error.detail && (
        <Collapsible className="w-full max-w-sm">
          <CollapsibleTrigger className="group flex items-center justify-center gap-0.5 underline-offset-2 hover:underline">
            <ChevronRightIcon className="size-3 transition-transform group-data-[panel-open]:rotate-90" />
            Details
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-left font-mono text-[10px]">
              {error.detail}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </>
  );
}
