import { Trash2Icon } from "lucide-react";
import { useState } from "react";
import { Btn } from "./v3-bits";
import { EscLayer, useFocusBack, useFocusOn } from "./v3-keys";
import type { V3PageProps } from "./v3-page-types";
import type { V3Agent } from "./v3-types";

/* The quiet end of an agent's page: take it off the team. It asks in place
   and says what happens first, because it cannot be undone: the record, the
   threads and the scheduled jobs go with it, the engine's own profile (its
   history, memory and skills) stays where it is. Afterwards the agent is
   gone, so the page lands on People. */

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function RemoveAgent({
  data,
  go,
  act,
  agent,
}: V3PageProps & { agent: V3Agent }) {
  const [asking, setAsking] = useState(false);
  // The question opens on its safe answer; closing it returns to the trigger.
  const cancelBtn = useFocusOn<HTMLButtonElement>(asking);
  const trigger = useFocusBack<HTMLButtonElement>(asking);
  const [busy, setBusy] = useState(false);
  const remove = act.removeAgent;
  if (!remove) return null;

  const threads = data.threads.filter((t) => t.agentId === agent.id).length;
  const jobs = data.schedules.filter((s) => s.agentId === agent.id).length;
  const goes = [
    `${agent.name}'s record`,
    ...(threads ? [count(threads, "thread")] : []),
    ...(jobs ? [count(jobs, "scheduled job")] : []),
  ];
  const goesText =
    goes.length > 1
      ? `${goes.slice(0, -1).join(", ")} and ${goes[goes.length - 1]}`
      : goes[0];

  const confirm = () => {
    setBusy(true);
    // A refused removal has been explained by the app; the question stays.
    remove(agent.id).then(
      () => go({ page: "people" }),
      () => setBusy(false),
    );
  };

  return (
    <div className="mt-14 border-[var(--v3-line)] border-t pt-4">
      {asking ? (
        <div
          role="group"
          aria-label={`Remove ${agent.name} from the company`}
          className="rounded-lg border border-[var(--v3-line)] bg-[var(--v3-soft)] px-4 py-3 text-[13.5px] leading-relaxed"
        >
          <EscLayer onEscape={() => !busy && setAsking(false)} />
          <p className="font-medium text-[14px] text-foreground">
            Remove {agent.name} from the company?
          </p>
          <p className="mt-1.5 text-muted-foreground">
            <span className="font-medium text-foreground">Goes:</span>{" "}
            {goesText}.
          </p>
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">Stays:</span> its
            engine profile, with its history, memory and skills.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Btn small primary onClick={busy ? undefined : confirm}>
              {busy ? "Removing…" : "Remove from company"}
            </Btn>
            <Btn
              small
              ref={cancelBtn}
              onClick={busy ? undefined : () => setAsking(false)}
            >
              Cancel
            </Btn>
          </div>
        </div>
      ) : (
        <button
          ref={trigger}
          type="button"
          onClick={() => setAsking(true)}
          className="inline-flex h-7 items-center gap-1.5 rounded-[7px] px-2 text-[13px] text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-red-600 dark:hover:text-red-300 [&_svg]:size-3.5"
        >
          <Trash2Icon />
          Remove from company
        </button>
      )}
    </div>
  );
}
