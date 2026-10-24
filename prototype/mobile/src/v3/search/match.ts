import { threadTag, type V3Data } from "@lilos/ui/v3-data";
import type {
  Person,
  SearchGroup,
  ThreadRowVM,
  TicketRowVM,
} from "@lilos/ui-native/v3";
import { CEO_THREAD_ID, personOf, threadRowVM, ticketRowVM } from "../model";

/* What the "Ask the CEO" field finds. Pure: it reads the company and builds
   the rows; the screen decides what a tap does. */

/** Each group shows this many rows; its heading says how many matched. */
export const GROUP_LIMIT = 20;

export type SearchHits = {
  people: SearchGroup<Person>;
  threads: SearchGroup<ThreadRowVM>;
  tickets: SearchGroup<TicketRowVM>;
};

/** Every word is somewhere in the text, so "build login" finds a "Login
    build" and typing more narrows the list. */
function matchesWords(
  words: string[],
  ...fields: (string | undefined)[]
): boolean {
  if (words.length === 0) return false;
  const hay = fields.join("\n").toLowerCase();
  return words.every((w) => hay.includes(w));
}

function group<S, R>(found: S[], row: (item: S) => R): SearchGroup<R> {
  return { total: found.length, rows: found.slice(0, GROUP_LIMIT).map(row) };
}

export function searchCompany(d: V3Data, query: string): SearchHits {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const people = d.agents.filter((a) =>
    matchesWords(words, a.name, a.role, a.description),
  );
  // The CEO's standing thread is what "Ask the CEO" already opens.
  const threads = d.threads.filter(
    (t) =>
      t.id !== CEO_THREAD_ID &&
      matchesWords(
        words,
        t.title,
        personOf(d, t.agentId).name,
        threadTag(d, t),
        t.summary,
        t.quote,
      ),
  );
  const tickets = d.tickets.filter((t) =>
    matchesWords(words, t.id, t.title, personOf(d, t.owner).name),
  );
  return {
    people: group(people, (a) => personOf(d, a.id)),
    threads: group(threads, (t) => threadRowVM(d, t)),
    tickets: group(tickets, (t) => ticketRowVM(d, t)),
  };
}
