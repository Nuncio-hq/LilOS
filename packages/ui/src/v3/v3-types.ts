/* UX v3 view models (prototype): the company as three databases (People,
   Work, Goals) in a calm, Notion-like layout. Every row answers who holds it,
   what state it is in, since when, and what it waits on. Not wire types. */

/** The one status vocabulary every screen shares. Colour is reserved for it. */
export type V3Status =
  | "working"
  | "waiting"
  | "needs"
  | "stuck"
  | "idle"
  | "done"
  | "planned"
  | "failed";

export type V3Tone = "c" | "b" | "r" | "m" | "s" | "d" | "n";

export type V3Connector = {
  name: string;
  icon: "web" | "bolt" | "spark" | "mail" | "sheet";
  /** Attached to this agent's sessions. */
  on: boolean;
};

export type V3Agent = {
  id: string;
  name: string;
  /** Avatar colour. */
  tone: V3Tone;
  role: string;
  /** Agent id; absent = reports to you. */
  reportsTo?: string;
  hired: string;
  runtime: string;
  model: string;
  schedule: string;
  connectors: V3Connector[];
  skills: string[];
  /** Dollars spent this period, and the cap. */
  spend: { used: number; cap: number; period: "week" | "month" };
  instructions: string[];
  /** A rule the CEO proposes after this agent got stuck. */
  suggestion?: { text: string; after: string };
  memory: { text: string; source: string }[];
  week: { done: number; typical: string; stuck: number; handed: number };
  /** Idle agents: what wakes them next. */
  next?: string;
};

export type V3Project = {
  id: string;
  name: string;
  /** Ticket prefix: LIL, HB, QR. */
  key: string;
  tone: V3Tone;
  folder: string;
  about: string;
};

export type V3Goal = {
  id: string;
  title: string;
  projectId: string;
  due: string;
  why: string;
};

/** What a ticket waits on. */
export type V3WaitingOn =
  | { kind: "you"; askId: string }
  | { kind: "agent"; agentId: string; why: string }
  | { kind: "ticket"; ticketId: string };

export type V3ProgressStep = {
  text: string;
  by: string;
  took: string;
  state: "done" | "current" | "todo";
};

export type V3Comment = {
  /** Agent id, or "you". */
  by: string;
  /** Minutes ago. */
  ago: number;
  text: string;
};

export type V3Ticket = {
  id: string;
  title: string;
  projectId: string;
  goalId?: string;
  /** Agent id. */
  owner: string;
  reviewer?: string;
  status: V3Status;
  waitingOn?: V3WaitingOn;
  /** Stuck: the plain-language reason ("same web search 6×"). */
  stuckWhy?: string;
  /** What the CEO does if nobody steps in. */
  fallback?: { at: string; does: string };
  /** Minutes in the current status. */
  since: number;
  started?: string;
  /** Planned tickets: when they start. */
  startsAt?: string;
  progress: V3ProgressStep[];
  result?: {
    pr?: { num: number; branch: string; add: number; del: number };
    files?: { name: string; note: string }[];
  };
  updates: V3Comment[];
  /** Done tickets: minutes since done. */
  doneAgo?: number;
};

export type V3StepKind =
  | "read"
  | "search"
  | "edit"
  | "run"
  | "web"
  | "think"
  | "delegate";

export type V3Step = {
  kind: V3StepKind;
  target: string;
  meta?: string;
  add?: number;
  del?: number;
  failed?: boolean;
  running?: boolean;
};

export type V3Turn = {
  n: number;
  /** "asked by CEO at 11:52". */
  from: string;
  took: string;
  /** Folded turns show this line instead of their steps. */
  summary?: string;
  facts?: string;
  steps?: V3Step[];
};

/** Thread = one agent session on one ticket, in one folder, with one model. */
export type V3Thread = {
  id: string;
  ticketId: string;
  agentId: string;
  /** This hand's job on the ticket ("Build two variants"). */
  title: string;
  status: V3Status;
  /** Finished since you last looked. */
  unseen?: boolean;
  startedAt: string;
  /** Minutes running (or ran). */
  minutes: number;
  turns: V3Turn[];
  step?: number;
  /** Context window used, percent. */
  context: number;
  model: string;
  folder: string;
  branch?: string;
  /** The step running now. */
  now?: { kind: V3StepKind; text: string; elapsed: string };
  /** Live output; the UI reveals lines over time. */
  live?: { cmd: string; lines: string[] };
  /** Two short lines under the step on the live card. */
  tail?: string[];
  quote?: string;
  /** Past threads: what they did, in one line. */
  summary?: string;
  askId?: string;
  stuck?: { what: string; detail: string[] };
  plan?: { text: string; state: "done" | "current" | "todo" }[];
  changes?: { path: string; add: number; del: number }[];
  helpers?: { text: string; took: string }[];
};

export type V3Ask = {
  id: string;
  ticketId: string;
  from: string;
  kind: "approval" | "question";
  title: string;
  /** Minutes waiting. */
  waiting: number;
  ask: string;
  why: string;
  ifYes: string;
  ifNo: string;
  spend?: { amount: number; used: number; cap: number };
  /** Offered as "let this agent do it without asking next time". */
  allowRule?: string;
  /** Question answers; the first is what happens by default. */
  options?: string[];
  /** If you don't answer by `at`, the CEO does this. */
  fallback: { at: string; does: string };
};

export type V3Update = {
  id: string;
  by: string;
  at: string;
  ticketId?: string;
  kind: "brief" | "done" | "handoff" | "stuck" | "plan";
  text: string;
};

/** The CEO's answer to one ⌘K line: either a reply or a draft plan. */
export type V3Draft =
  | { kind: "answer"; text: string }
  | {
      kind: "plan";
      lead: string;
      goalId?: string;
      hours: number;
      cost: number;
      tickets: {
        id: string;
        title: string;
        owner: string;
        after?: string;
        est: string;
        asksYou?: boolean;
      }[];
    };

export type V3Data = {
  company: string;
  me: string;
  today: string;
  agents: V3Agent[];
  projects: V3Project[];
  goals: V3Goal[];
  tickets: V3Ticket[];
  threads: V3Thread[];
  asks: V3Ask[];
  updates: V3Update[];
};

export type V3Route =
  | { page: "home" }
  | { page: "needs" }
  | { page: "inbox" }
  | { page: "work"; view?: "waiting" | "board" | "project" | "timeline" }
  | { page: "ticket"; id: string }
  | { page: "threads"; view?: "live" | "all" | "agent" }
  | { page: "thread"; id: string }
  | { page: "goals" }
  | { page: "goal"; id: string }
  | { page: "project"; id: string }
  | { page: "people"; view?: "table" | "org" }
  | { page: "agent"; id: string }
  | { page: "hire" }
  | { page: "guide" };

/** Everything a page can change; the shell owns the state. */
export type V3Actions = {
  approve: (askId: string, alwaysAllow?: boolean) => void;
  deny: (askId: string) => void;
  answer: (askId: string, option: string) => void;
  stop: (threadId: string) => void;
  handOff: (ticketId: string, agentId: string) => void;
  acceptRule: (agentId: string) => void;
  dismissRule: (agentId: string) => void;
  comment: (ticketId: string, text: string) => void;
  message: (threadId: string, text: string) => void;
  markSeen: (threadId: string) => void;
  hire: (agent: { name: string; role: string; model: string }) => void;
  /** Opens the ⌘K palette, optionally prefilled. */
  ask: (text?: string) => void;
};

export type V3PageProps = {
  data: V3Data;
  go: (route: V3Route) => void;
  act: V3Actions;
};
