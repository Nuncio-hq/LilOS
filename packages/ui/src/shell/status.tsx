import {
  ActivityIcon,
  CheckCircle2Icon,
  CircleMinusIcon,
  CopyIcon,
  CpuIcon,
  FileWarningIcon,
  LoaderCircleIcon,
  RadioIcon,
  TriangleAlertIcon,
  WrenchIcon,
  XCircleIcon,
  XIcon,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { InlineCodeText } from "../lib/inline-code";
import { cn } from "../lib/utils";
import type { ComponentState, StatusComponent } from "../types";

/* System status: the chain a session needs — relay → harness → engine → model — each with
   a state and a one-line reason. StatusRow sits at the bottom of the sidebar and opens
   StatusDialog. The app passes rows + the diagnostics text; this file only renders.
   `blocked` (#53): the leg waits on an upstream failure — neutral gray, and it never
   counts as an issue in the summary. */

const STATE_STYLE: Record<ComponentState, { dot: string; chip: string }> = {
  ok: { dot: "bg-emerald-500", chip: "text-emerald-700" },
  connecting: { dot: "bg-amber-500 animate-pulse", chip: "text-amber-700" },
  degraded: { dot: "bg-amber-500", chip: "text-amber-700" },
  blocked: { dot: "bg-slate-400", chip: "text-slate-500" },
  down: { dot: "bg-red-500", chip: "text-red-700" },
};

const COMPONENT_ICON = {
  relay: RadioIcon,
  harness: WrenchIcon,
  engine: CpuIcon,
  model: FileWarningIcon,
} as const;

const STATE_ICON: Record<
  ComponentState,
  { icon: typeof CheckCircle2Icon; className: string }
> = {
  ok: { icon: CheckCircle2Icon, className: "text-emerald-600" },
  connecting: {
    icon: LoaderCircleIcon,
    className: "animate-spin text-amber-600",
  },
  degraded: { icon: TriangleAlertIcon, className: "text-amber-600" },
  blocked: { icon: CircleMinusIcon, className: "text-slate-400" },
  down: { icon: XCircleIcon, className: "text-red-600" },
};

/** A leg counts as an issue only when it is itself unhealthy — `blocked`
    just waits on a leg upstream of it (#53). */
const isIssue = (c: StatusComponent) =>
  c.state !== "ok" && c.state !== "blocked";

export function statusSummary(components: StatusComponent[]) {
  const bad = components.filter(isIssue);
  return bad.length === 0
    ? "All systems normal"
    : `${bad.length} issue${bad.length > 1 ? "s" : ""} · ${bad[0].label} ${bad[0].state}`;
}

export function StatusRow({
  components,
  onOpen,
}: {
  components: StatusComponent[];
  onOpen: () => void;
}) {
  const bad = components.filter(isIssue);
  const worst = bad[0];
  const state: ComponentState = worst?.state ?? "ok";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="System status"
      className="flex w-full items-center gap-2 border-sidebar-border border-t px-4 py-2 text-left text-xs hover:bg-sidebar-accent"
    >
      <span
        className={cn("size-2 shrink-0 rounded-full", STATE_STYLE[state].dot)}
      />
      <span className="min-w-0 truncate">{statusSummary(components)}</span>
      <ActivityIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

/* The legs list itself, shared by StatusDialog and the Settings Status pane
   (issue #139): one row per component with state chip, reason, hint and the
   collapsed raw detail. */
export function StatusList({ components }: { components: StatusComponent[] }) {
  return (
    <div className="divide-y">
      {components.map((c) => {
        const Icon = COMPONENT_ICON[c.id];
        const st = STATE_STYLE[c.state];
        const StateIcon = STATE_ICON[c.state].icon;
        return (
          <div key={c.id} className="flex items-start gap-3 px-4 py-3">
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{c.label}</span>
                <span
                  className={cn(
                    "flex items-center gap-1 font-medium text-xs",
                    st.chip,
                  )}
                >
                  <span className={cn("size-1.5 rounded-full", st.dot)} />
                  {c.state}
                </span>
                <StateIcon
                  className={cn(
                    "ml-auto size-4 shrink-0",
                    STATE_ICON[c.state].className,
                  )}
                />
              </div>
              <p className="mt-0.5 text-muted-foreground text-xs">
                <InlineCodeText text={c.reason} />
              </p>
              {c.hint && (
                <p className="mt-0.5 text-foreground/80 text-xs">
                  <InlineCodeText text={c.hint} />
                </p>
              )}
              {c.detail && (
                <details className="mt-1">
                  <summary className="cursor-pointer select-none text-muted-foreground text-xs">
                    Details
                  </summary>
                  <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
                    {c.detail}
                  </pre>
                </details>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function StatusDialog({
  components,
  diagnostics,
  onClose,
  onCopied,
}: {
  components: StatusComponent[];
  diagnostics: string;
  onClose: () => void;
  onCopied: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/30 p-6"
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <div
        role="dialog"
        aria-label="System status"
        className="w-full max-w-md overflow-hidden rounded-2xl border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b p-4">
          <ActivityIcon className="size-5 text-muted-foreground" />
          <div className="flex-1">
            <div className="font-semibold">System status</div>
            <div className="text-muted-foreground text-xs">
              relay → harness → engine → model — what a session needs to run
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </div>
        <ScrollArea className="max-h-[60dvh]">
          <StatusList components={components} />
        </ScrollArea>
        <div className="flex items-center gap-2 border-t bg-muted/30 p-3">
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => {
              navigator.clipboard.writeText(diagnostics);
              onCopied();
            }}
          >
            <CopyIcon />
            Copy diagnostics
          </Button>
        </div>
      </div>
    </div>
  );
}
