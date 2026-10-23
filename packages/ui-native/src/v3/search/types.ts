import type { Person, ThreadRowVM, TicketRowVM } from "../types";

/* View models for "Ask the CEO": the search results under the native field. */

/** One matching group: the first few rows, and how many matched in all. */
export type SearchGroup<T> = {
  total: number;
  rows: T[];
};

/** One of the CEO's recent updates. */
export type RecentUpdateVM = {
  id: string;
  /** Who wrote it; absent for a system note, which is LilOS, not an agent. */
  who?: Person;
  /** "LilOS" for a system note, else the person's name. */
  whoName: string;
  at: string;
  text: string;
  /** The ticket it is about, as its id. */
  ticketTag?: string;
};

export type SearchResultsProps = {
  /** What is typed, trimmed; empty shows the CEO's recent updates. */
  query: string;
  /** The CEO the question goes to; absent when the company has none yet. */
  ceo?: Person;
  recent: RecentUpdateVM[];
  people: SearchGroup<Person>;
  threads: SearchGroup<ThreadRowVM>;
  tickets: SearchGroup<TicketRowVM>;
  onAsk: () => void;
  onOpenCeoThread: () => void;
  onOpenPerson: (id: string) => void;
  onOpenThread: (id: string) => void;
  onOpenTicket: (id: string) => void;
};
