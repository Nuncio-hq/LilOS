import { AlertTriangleIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";

/* A designed state banner pinned above the main column: reconnecting, harness down,
   engine down, version mismatch. `action` renders only when its handler is passed. */
export function StatusBanner({
  tone = "amber",
  icon,
  action,
  inline,
  children,
}: {
  tone?: "amber" | "red" | "blue";
  icon?: ReactNode;
  action?: { label: string; onClick: () => void };
  /* `inline` hugs the content (a bordered card instead of a full-bleed
     strip) so the action button sits right after the text — for notices
     that live inside a constrained column (#423). */
  inline?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-status-banner
      role="status"
      className={cn(
        "flex shrink-0 items-center gap-2 px-3 py-2 text-xs",
        inline ? "w-fit max-w-full rounded-md border" : "border-b sm:px-5",
        tone === "amber" && "border-amber-200 bg-amber-50 text-amber-900",
        tone === "red" && "border-red-200 bg-red-50 text-red-900",
        tone === "blue" && "border-blue-200 bg-blue-50 text-blue-900",
      )}
    >
      {icon ?? <AlertTriangleIcon className="size-3.5 shrink-0" />}
      <div className="min-w-0 flex-1">{children}</div>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="shrink-0 rounded-md border border-current/30 px-2 py-0.5 font-medium hover:bg-white/40"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
