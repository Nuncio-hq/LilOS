import { Section, StatusPill } from "./v3-bits";
import type { V3Status } from "./v3-types";

/* What each status means, shared by both Guides. Without tickets there is no
   "paused on another ticket" to be in, so Waiting is left out and Idle waits
   for a message alone. */

const MEANINGS: {
  status: V3Status;
  word?: string;
  text: string;
  /** Wording where there are no tickets; absent: same text. */
  plain?: string;
  /** Only exists with tickets. */
  ticketsOnly?: boolean;
}[] = [
  { status: "working", text: "An agent is on it right now." },
  {
    status: "waiting",
    text: "Paused on someone else: a teammate, or another ticket.",
    ticketsOnly: true,
  },
  {
    status: "needs",
    text: "Only you can unblock it: an approval or a question.",
  },
  {
    status: "stuck",
    text: "It keeps repeating the same step. Stop it or hand it on.",
  },
  {
    status: "idle",
    text: "Nothing to do until the next ticket or message.",
    plain: "Nothing to do until the next message.",
  },
  {
    status: "done",
    word: "Finished",
    text: "Delivered. It stays here until you have looked.",
  },
];

export function Statuses({ tickets }: { tickets: boolean }) {
  const shown = MEANINGS.filter((m) => tickets || !m.ticketsOnly);
  return (
    <>
      <Section
        title={`${shown.length === 6 ? "Six" : "Five"} statuses, colour only for status`}
      />
      <div className="border-[var(--v3-line)] border-t">
        {shown.map((m) => (
          <div
            key={m.status}
            className="grid grid-cols-[150px_minmax(0,1fr)] items-center gap-5 border-[var(--v3-line)] border-b py-2.5 text-[13.5px]"
          >
            <span>
              <StatusPill status={m.status} label={m.word} />
            </span>
            <span className="text-muted-foreground">
              {tickets ? m.text : (m.plain ?? m.text)}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
