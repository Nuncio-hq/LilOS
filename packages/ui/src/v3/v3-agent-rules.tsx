import { cn } from "../lib/utils";
import { AgentAvatar, Btn, Section } from "./v3-bits";
import type { V3Actions, V3Agent, V3Data } from "./v3-types";

/* What sits under an agent's instructions: a rule the CEO proposes after it
   got stuck, and what it remembers. */

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

export function Memory({ memory }: { memory: NonNullable<V3Agent["memory"]> }) {
  return (
    <>
      <Section title="Remembers" count={memory.length} />
      <ul className="border-[var(--v3-line)] border-t text-[14px]">
        {memory.map((m) => (
          <li
            key={m.text}
            className="flex items-baseline gap-4 border-[var(--v3-line)] border-b py-2 text-foreground"
          >
            <span className="min-w-0 flex-1">{m.text}</span>
            <span className="shrink-0 text-[12.5px] text-muted-foreground/70">
              {m.source}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
