import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CopyIcon,
} from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import type { PrError } from "../types";

/* A shell command rendered as a copyable code chip (#114 AC-5). */
function CmdChip({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={`Copy: ${cmd}`}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(cmd)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          })
          .catch(() => {});
      }}
      className="mx-0.5 inline-flex items-center gap-1 rounded border bg-muted/60 px-1.5 py-px font-mono text-[11px] text-foreground"
    >
      {cmd}
      {copied ? (
        <CheckIcon className="size-3 text-emerald-600" />
      ) : (
        <CopyIcon className="size-3" />
      )}
    </button>
  );
}

/* The PR tab's `gh`-failed state: plain copy per reason + one next step, the
   raw stderr only behind Details — never the headline (#114 AC-5). */
export function PrFailure({
  error,
  onRetry,
}: {
  error: PrError;
  onRetry?: () => void;
}) {
  return (
    <>
      <CircleAlertIcon className="size-5" />
      {error.reason === "missing" ? (
        <p>
          GitHub CLI isn't installed. Install it with{" "}
          <CmdChip cmd="brew install gh" />, then reopen this tab.
        </p>
      ) : error.reason === "unauthenticated" ? (
        <p>
          Sign in to GitHub to see this PR: run <CmdChip cmd="gh auth login" />{" "}
          in Terminal.
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
