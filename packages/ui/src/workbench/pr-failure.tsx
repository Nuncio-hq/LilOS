import { ChevronRightIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import type { PrError } from "../types";
import { WbBtn, WbEmpty } from "./wb-bits";

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
  const message =
    error.reason === "missing"
      ? `GitHub CLI isn't installed on this machine. Ask ${employeeName} to install it, then Retry.`
      : error.reason === "unauthenticated"
        ? `GitHub isn't signed in on this machine. Ask ${employeeName} to sign in, then Retry.`
        : "Couldn't load the PR.";
  return (
    <WbEmpty
      action={
        (onRetry || error.detail) && (
          <div className="space-y-2">
            {onRetry && <WbBtn onClick={onRetry}>Retry</WbBtn>}
            {error.detail && (
              <Collapsible className="max-w-sm">
                <CollapsibleTrigger className="group flex items-center gap-0.5 text-[12px] text-muted-foreground underline-offset-2 hover:underline">
                  <ChevronRightIcon className="size-3 transition-transform group-data-[panel-open]:rotate-90" />
                  Details
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-[7px] bg-[var(--v3-soft)] p-2 text-left font-mono text-[11px]">
                    {error.detail}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        )
      }
    >
      {message}
    </WbEmpty>
  );
}
