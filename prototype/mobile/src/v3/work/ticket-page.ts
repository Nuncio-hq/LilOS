import {
  goalOf,
  projectOf,
  threadsOf,
  type V3Data,
  type V3Ticket,
  waitingLabel,
} from "@lilos/ui/v3-data";
import type { TicketFact, TicketPageVM } from "@lilos/ui-native/v3";
import { agoText, askVM, personOf, STATUS_WORDS, threadRowVM } from "../model";

/* A ticket's page: every line is a real field of the ticket, resolved to
   words. A field the ticket does not have is not shown. */

function factsOf(
  d: V3Data,
  t: V3Ticket,
  ask?: { fallback?: string },
): TicketFact[] {
  const facts: TicketFact[] = [];
  const project = projectOf(d, t.projectId);
  if (project) facts.push({ label: "Project", value: project.name });
  const goal = t.goalId ? goalOf(d, t.goalId) : undefined;
  if (goal) facts.push({ label: "Goal", value: goal.title });
  // With the ask shown below, "Waiting on You" would only repeat its heading.
  if (t.waitingOn && !ask) {
    const who = waitingLabel(d, t);
    facts.push({
      label: "Waiting on",
      value: t.waitingOn.kind === "agent" ? `${who} ${t.waitingOn.why}` : who,
    });
  }
  if (t.stuckWhy) facts.push({ label: "Stuck", value: t.stuckWhy });
  const fallback = t.fallback
    ? `At ${t.fallback.at} the CEO ${t.fallback.does}.`
    : undefined;
  // The ask block already says it when both carry the same line.
  if (fallback && fallback !== ask?.fallback)
    facts.push({ label: "Otherwise", value: fallback });
  if (t.status === "done") {
    if (t.doneAgo !== undefined)
      facts.push({ label: "Done", value: agoText(t.doneAgo) });
  } else if (t.status !== "planned") {
    facts.push({ label: "Since", value: agoText(t.since) });
  }
  if (t.started) facts.push({ label: "Started", value: t.started });
  if (t.startsAt) facts.push({ label: "Starts", value: t.startsAt });
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
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    statusWord: STATUS_WORDS[t.status],
    owner: personOf(d, t.owner),
    facts: factsOf(d, t, ask),
    ask,
    progress: t.progress.map((s) => ({
      text: s.text,
      state: s.state,
      who: personOf(d, s.by).name,
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
    updates: t.updates.map((u, i) => ({
      id: `${t.id}-${i}`,
      who: u.authorKind === "system" || !u.by ? undefined : personOf(d, u.by),
      ago: agoText(u.ago),
      text: u.text,
    })),
    threads: threadsOf(d, t.id).map((th) => threadRowVM(d, th)),
  };
}
