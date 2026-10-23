import type { AskVM, Person, Status, ThreadRowVM } from "../types";

/* The ticket page as props. Every name is already resolved (nothing here is
   an agent id) and every time is already words. */

export type TicketFact = { label: string; value: string };

export type TicketStepVM = {
  text: string;
  state: "done" | "current" | "todo";
  /** Who does it, by name ("you" is the owner's own name). */
  who: string;
  /** "12m", "41m so far", or "" while it has not started. */
  took: string;
};

export type TicketResultVM = {
  /** "#66 · paywall-copy-ab · +214 −38" */
  pr?: string;
  files: { name: string; note: string }[];
};

export type TicketUpdateVM = {
  id: string;
  /** Absent for a note LilOS wrote itself. */
  who?: Person;
  /** "26 min ago" */
  ago: string;
  text: string;
};

export type TicketPageVM = {
  id: string;
  title: string;
  status: Status;
  statusWord: string;
  owner: Person;
  /** Project, goal, what it waits on, why it is stuck, since, started … */
  facts: TicketFact[];
  /** The ask this ticket waits on you for, while it is still open. */
  ask?: AskVM;
  progress: TicketStepVM[];
  result?: TicketResultVM;
  updates: TicketUpdateVM[];
  threads: ThreadRowVM[];
};
