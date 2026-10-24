/* View models the v3 screens take as props. The app (prototype/mobile) turns
   its company data into these; nothing here knows where the data lives. */

/** The one status vocabulary every screen shares. Colour is reserved for it. */
export type Status =
  | "working"
  | "waiting"
  | "needs"
  | "stuck"
  | "idle"
  | "done"
  | "planned"
  | "failed";

/** Whoever a line is about: an agent or an outside worker. */
export type Person = {
  id: string;
  name: string;
  role: string;
  /** Holds the CEO position: wears the CEO chip. */
  isCeo: boolean;
  /** An always-on bot reached through a connector, not a LilOS agent. */
  outside: boolean;
};

/** One thing waiting on you. Approval = yes/no, question = pick an option,
    plan = a plan to read in its thread, then approve or reject. */
export type AskVM = {
  id: string;
  kind: "approval" | "question" | "plan";
  from: Person;
  title: string;
  /** What is asked, one sentence. */
  ask: string;
  why?: string;
  ifYes?: string;
  ifNo?: string;
  /** Where it lives: its ticket id, its project, or "Chat". */
  tag: string;
  /** "41 min" — how long it has waited. */
  waiting: string;
  /** Question: the choices, the first is the default. */
  options?: string[];
  /** "$40 · $112 of $300 this month" */
  spend?: string;
  /** "At 15:00 the CEO denies it." */
  fallback?: string;
  /** The thread the ask belongs to, where the plan or context reads. */
  threadId?: string;
};

/** A thread in a list: Work, search, an agent's page, a ticket's page. */
export type ThreadRowVM = {
  id: string;
  title: string;
  agent: Person;
  status: Status;
  /** "Needs you", "Working" … for the status word. */
  statusWord: string;
  /** Ticket id, project name, or "Chat". */
  tag: string;
  /** "Started 11:02 · 62 min" or what it did, one line. */
  detail: string;
  unseen: boolean;
};

export type TicketRowVM = {
  id: string;
  title: string;
  owner: Person;
  status: Status;
  statusWord: string;
  /** "waits on You", "stuck: same web search 6×", "starts after HB-12", "done 2 h ago". */
  detail: string;
};

/** One finished thing to look at, ready to draw (Home and Needs show it). */
export type ResultVM = {
  key: string;
  title: string;
  by: Person;
  note: string;
  /** Where it lives: ticket id, project or "Chat". */
  tag: string;
  /** "41 min ago" */
  ago: string;
  /** Finished past your read mark. */
  unseen: boolean;
  /** It has a thread or a ticket to open; without either the row is plain. */
  openable: boolean;
};
