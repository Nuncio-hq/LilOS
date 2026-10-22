import { cn } from "../lib/utils";
import { Btn } from "./v3-bits";
import type { V3Data } from "./v3-data-types";
import { AgentAvatar } from "./v3-marks";
import type { V3Actions } from "./v3-page-types";
import type { V3Agent } from "./v3-types";

/* A rule the CEO proposes after an agent got stuck. What the agent
   remembers is its notes (one list), not a second section here. */

/** The CEO's proposed rule; `ceo` is who proposes it. */
export function RuleSuggestion({
  data,
  agent,
  ceo,
  act,
  gap,
}: {
  data: V3Data;
  agent: V3Agent;
  ceo: V3Agent;
  act: V3Actions;
  /** Space above: tight under instructions, wider when there are none. */
  gap: string;
}) {
  const s = agent.suggestion;
  if (!s) return null;
  return (
    <div
      className={cn(
        gap,
        "flex items-start gap-2.5 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-[13.5px] dark:border-sky-400/25 dark:bg-sky-400/10",
      )}
    >
      <AgentAvatar data={data} agent={ceo} className="mt-px" />
      <div className="min-w-0 flex-1">
        <span className="font-semibold text-foreground">
          CEO suggests a rule
        </span>{" "}
        <span className="text-muted-foreground">
          · after {s.after} got stuck
        </span>
        <div className="mt-1">
          <span className="rounded-[3px] bg-emerald-100 px-1 text-emerald-800 dark:bg-emerald-400/20 dark:text-emerald-200">
            {s.text}
          </span>
        </div>
      </div>
      {(act.dismissRule || act.acceptRule) && (
        <div className="flex shrink-0 gap-2">
          {act.dismissRule && (
            <Btn small onClick={() => act.dismissRule?.(agent.id)}>
              Dismiss
            </Btn>
          )}
          {act.acceptRule && (
            <Btn small primary onClick={() => act.acceptRule?.(agent.id)}>
              Accept
            </Btn>
          )}
        </div>
      )}
    </div>
  );
}
