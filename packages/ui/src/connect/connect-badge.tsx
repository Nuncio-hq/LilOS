import {
  CheckCircle2Icon,
  Loader2Icon,
  TriangleAlertIcon,
  UnplugIcon,
} from "lucide-react";
import { cn } from "../lib/utils";
import type { ConnectionState } from "../types";

/* The one-line pill every surface uses for a profile's LilOS connection state
   (issue #338): the Connect step, Settings → Engine rows, and the DM notice
   all read the same labels so the states never drift. */
const META: Record<
  ConnectionState,
  { icon: typeof CheckCircle2Icon; label: string; cls: string }
> = {
  connected: {
    icon: CheckCircle2Icon,
    label: "Connected",
    cls: "text-emerald-600 dark:text-emerald-400",
  },
  "not-connected": {
    icon: UnplugIcon,
    label: "Not connected",
    cls: "text-muted-foreground",
  },
  updating: {
    icon: Loader2Icon,
    label: "Updating",
    cls: "text-blue-600 dark:text-blue-400",
  },
  failed: {
    icon: TriangleAlertIcon,
    label: "Failed",
    cls: "text-red-600 dark:text-red-400",
  },
};

export function ConnectBadge({
  state,
  className,
}: {
  state: ConnectionState;
  className?: string;
}) {
  const { icon: Icon, label, cls } = META[state];
  return (
    <span
      data-connect-state={state}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 font-medium text-xs",
        cls,
        className,
      )}
    >
      <Icon
        className={cn("size-3.5", state === "updating" && "animate-spin")}
      />
      {label}
    </span>
  );
}
