import type { ThreadRowVM, TicketRowVM } from "../types";

/* What the Work tab draws: one group per project (plus "Chat" for threads
   that live in no project). The app orders the rows; this only shows them. */

type WorkGroupHead = {
  id: string;
  /** The project's name, or "Chat". */
  name: string;
  /** "3 open" — how much of the group is still going. */
  caption: string;
  /** What the project is about, one line; absent for Chat. */
  about?: string;
};

export type WorkThreadGroup = WorkGroupHead & {
  /** The live and recent threads, most pressing first. */
  rows: ThreadRowVM[];
  /** Finished and already seen: listed last and drawn quietly. */
  quiet: ThreadRowVM[];
};

export type WorkTicketGroup = WorkGroupHead & {
  rows: TicketRowVM[];
  /** Done tickets, behind one collapsed "N done" line. */
  done: TicketRowVM[];
};

export type WorkView = "threads" | "tickets";

/** One project's page: all of its threads, and its tickets when the company
    has tickets switched on. */
export type ProjectPageVM = {
  id: string;
  name: string;
  about?: string;
  threads: WorkThreadGroup;
  tickets?: WorkTicketGroup;
};
