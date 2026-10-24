import type { Person, Status, ThreadRowVM, TicketRowVM } from "../types";

/* What Work and a project's page draw. The app orders everything; these
   screens only show it. */

/** One piece of open work: a ticket, or a plain chat that belongs to no
    ticket. The one line a module shows for it. */
export type WorkItemVM = {
  /** "ticket:HB-11" / "thread:t-hb11": unique across both kinds. */
  key: string;
  kind: "ticket" | "thread";
  /** The ticket's or the thread's own id. */
  id: string;
  title: string;
  status: Status;
  /** The ticket's owner, or the thread's agent. */
  who: Person;
  /** The project it lives in ("Chat" for none). */
  where: string;
};

export type WorkProjectVM = {
  id: string;
  name: string;
  /** "2 working · 1 stuck", or "Nothing open". */
  summary: string;
  /** Open work, most pressing first. */
  items: WorkItemVM[];
};

export type WorkScreenProps = {
  /** What wants you across all projects: needs you, stuck, failed. */
  attention: WorkItemVM[];
  projects: WorkProjectVM[];
  onOpenItem: (item: WorkItemVM) => void;
  onOpenProject: (projectId: string) => void;
};

export type WorkView = "threads" | "tickets";

/** One list on a project's page: what is open, and what is finished. */
export type ProjectList<Row> = { open: Row[]; done: Row[] };

export type ProjectPageVM = {
  id: string;
  name: string;
  /** What the project is about; absent for Chat. */
  about?: string;
  threads: ProjectList<ThreadRowVM>;
  /** Absent when the company has no tickets (or for Chat). */
  tickets?: ProjectList<TicketRowVM>;
};

export type ProjectScreenProps = {
  /** Absent when the project no longer exists. */
  page: ProjectPageVM | undefined;
  view: WorkView;
  onView: (view: WorkView) => void;
  onOpenThread: (threadId: string) => void;
  onOpenTicket: (ticketId: string) => void;
};
