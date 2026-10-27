import { Trash2Icon } from "lucide-react";
import { useState } from "react";
import { Btn } from "./v3-bits";
import type { V3Data } from "./v3-data-types";
import { EscLayer, useFocusBack, useFocusOn } from "./v3-keys";
import type { V3PageProps } from "./v3-page-types";
import type { V3Agent } from "./v3-types";

/* The quiet end of an agent's page — and the last item of the new chat's
   agent menu: take the agent off LilOS. It asks in place and says what
   happens first, because it cannot be undone: the record, the threads and
   the scheduled jobs go with it (running turns are stopped first — the
   relay drops the channel, the harness stops its session), while the
   engine's own profile, the CLI login with its history, memory and skills,
   stays where it is (D-#29). Afterwards the agent is gone, so the page
   lands on People — Home while the company layer is paused (D-#836). */

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The question Remove asks, wherever it is asked from. It opens on the
   safe answer; Esc or Cancel puts it away without removing. */
export function RemoveAsk({
  data,
  agent,
  busy,
  onConfirm,
  onCancel,
}: {
  data: V3Data;
  agent: V3Agent;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelBtn = useFocusOn<HTMLButtonElement>(true);
  const threads = data.threads.filter((t) => t.agentId === agent.id);
  const running = threads.some((t) => t.status === "working");
  const jobs = data.schedules.filter((s) => s.agentId === agent.id).length;
  const goes = [
    agent.name,
    ...(threads.length ? [`its ${count(threads.length, "thread")}`] : []),
    ...(jobs ? [`its ${count(jobs, "scheduled job")}`] : []),
  ];
  const goesText =
    goes.length > 1
      ? `${goes.slice(0, -1).join(", ")} and ${goes[goes.length - 1]}`
      : goes[0];

  return (
    <div
      role="group"
      aria-label={`Remove ${agent.name} from LilOS`}
      className="rounded-lg border border-[var(--v3-line)] bg-[var(--v3-soft)] px-4 py-3 text-[13.5px] leading-relaxed"
    >
      <EscLayer onEscape={() => !busy && onCancel()} />
      <p className="font-medium text-[14px] text-foreground">
        Remove {agent.name} from LilOS?
      </p>
      <p className="mt-1.5 text-muted-foreground">
        <span className="font-medium text-foreground">Goes:</span> {goesText} in
        LilOS.
        {running && " Anything running is stopped first."}
      </p>
      <p className="text-muted-foreground">
        Your chats stay; you can add it back any time.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <Btn small primary onClick={busy ? undefined : onConfirm}>
          {busy ? "Removing…" : "Remove from LilOS"}
        </Btn>
        <Btn small ref={cancelBtn} onClick={busy ? undefined : onCancel}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

export function RemoveAgent({
  data,
  go,
  act,
  agent,
}: V3PageProps & { agent: V3Agent }) {
  const [asking, setAsking] = useState(false);
  // The question opens on its safe answer; closing it returns to the trigger.
  const trigger = useFocusBack<HTMLButtonElement>(asking);
  const [busy, setBusy] = useState(false);
  const remove = act.removeAgent;
  if (!remove) return null;

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
        <RemoveAsk
          data={data}
          agent={agent}
          busy={busy}
          onConfirm={confirm}
          onCancel={() => setAsking(false)}
        />
      ) : (
        <button
          ref={trigger}
          type="button"
          onClick={() => setAsking(true)}
          className="inline-flex h-7 items-center gap-1.5 rounded-[7px] px-2 text-[13px] text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-red-600 dark:hover:text-red-300 [&_svg]:size-3.5"
        >
          <Trash2Icon />
          Remove from LilOS
        </button>
      )}
    </div>
  );
}
