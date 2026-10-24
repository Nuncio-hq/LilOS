import {
  goalOf,
  projectOf,
  threadsOf,
  type V3Data,
  type V3Ticket,
  waitingLabel,
} from "@lilos/ui/v3-data";
import type { TicketFact, TicketPageVM } from "@lilos/ui-native/v3";
import {
  agoText,
  askVM,
  minutesText,
  personOf,
  STATUS_WORDS,
  threadRowVM,
} from "../model";

/* A ticket's page: every line is a real field of the ticket, resolved to
   words. A field the ticket does not have is not shown. */

const capital = (s: string) => s.slice(0, 1).toUpperCase() + s.slice(1);

/** Whoever acted, by name; the owner is "You", never their own name (the
    same word `waitingLabel` uses). */
const whoOf = (d: V3Data, id: string) =>
  id === "you" ? { ...personOf(d, id), name: "You" } : personOf(d, id);

/** "Needs you · 41 min": the status word and how long it has been so. */
function statusLine(t: V3Ticket): string {
  const word = STATUS_WORDS[t.status];
  if (t.status === "done")
    return t.doneAgo === undefined ? word : `${word} · ${agoText(t.doneAgo)}`;
  if (t.status === "planned")
    return t.startsAt ? `${word} · starts ${t.startsAt}` : word;
  return `${word} · ${minutesText(t.since)}`;
}

/** Why it is in its state, when the status line and the decision below do
    not already say so. */
function noteOf(d: V3Data, t: V3Ticket, hasAsk: boolean): string | undefined {
  if (t.stuckWhy) return capital(t.stuckWhy);
  const w = t.waitingOn;
  if (!w || hasAsk) return undefined;
  const who = waitingLabel(d, t);
  return `Waiting on ${w.kind === "agent" ? `${who} ${w.why}` : who}`;
}

/** Reviewer and fallback, with the start time beside them; a start time
    alone is not worth a module. */
function factsOf(
  d: V3Data,
  t: V3Ticket,
  ask?: { fallback?: string },
): TicketFact[] {
  const facts: TicketFact[] = [];
  if (t.reviewer)
    facts.push({ label: "Reviewer", value: personOf(d, t.reviewer).name });
  const fallback = t.fallback
    ? `At ${t.fallback.at} the CEO ${t.fallback.does}.`
    : undefined;
  // The decision already says it when both carry the same line.
  if (fallback && fallback !== ask?.fallback)
    facts.push({ label: "Otherwise", value: fallback });
  if (facts.length > 0 && t.started)
    facts.push({ label: "Started", value: t.started });
  return facts;
}

export function ticketPageVM(d: V3Data, t: V3Ticket): TicketPageVM {
  const waitingOn = t.waitingOn;
  const open =
    waitingOn?.kind === "you"
      ? d.asks.find((a) => a.id === waitingOn.askId)
      : undefined;
  const ask = open ? askVM(d, open) : undefined;
  const pr = t.result?.pr;
  const files = t.result?.files ?? [];
  const goal = t.goalId ? goalOf(d, t.goalId) : undefined;
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    statusLine: statusLine(t),
    owner: personOf(d, t.owner),
    chips: [projectOf(d, t.projectId)?.name, goal?.title].filter(
      (c): c is string => !!c,
    ),
    note: noteOf(d, t, !!ask),
    ask,
    progress: t.progress.map((s) => ({
      text: s.text,
      state: s.state,
      who: whoOf(d, s.by).name,
      took: s.took,
    })),
    result:
      pr || files.length > 0
        ? {
            pr: pr
              ? `#${pr.num} · ${pr.branch} · +${pr.add} −${pr.del}`
              : undefined,
            files,
          }
        : undefined,
    updates: t.updates
      .map((u, i) => ({ u, i }))
      .sort((a, b) => a.u.ago - b.u.ago)
      .map(({ u, i }) => ({
        id: `${t.id}-${i}`,
        who: u.authorKind === "system" || !u.by ? undefined : whoOf(d, u.by),
        ago: agoText(u.ago),
        text: u.text,
      })),
    threads: threadsOf(d, t.id).map((th) => threadRowVM(d, th)),
    facts: factsOf(d, t, ask),
  };
}
