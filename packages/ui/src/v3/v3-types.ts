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

/** An outside service agents use: a command on the Mac (CLI) or an MCP
   server. LilOS keeps what to run and who uses it, never credentials (each
   connector keeps its own login). Its name, mark and colour come from the
   connector itself (an MCP server's serverInfo, or what you set when adding a
   CLI), so LilOS code never names a provider; only data does. */
export type V3ConnectorDef = {
  id: string;
  /** Display name, from the connector. */
  label: string;
  kind: "cli" | "mcp";
  /** What LilOS runs: a command line, or an MCP server's command / URL. */
  command: string;
  /** What it does, one line. */
  about: string;
  /** ready: found and signed in · missing: not installed · signed-out: needs its own login. */
  state: "ready" | "missing" | "signed-out";
  /** Its mark: one or two characters on its colour. */
  look: { mark: string; color: string };
  /** Agents whose sessions get it. */
  agents: string[];
};

export type V3Agent = {
  id: string;
  name: string;
  /** Avatar colour. */
  tone: V3Tone;
  role: string;
  /** Agent id; absent = reports to you (the CEO does). */
  reportsTo?: string;
  /** Absent: a LilOS agent (a runtime + model working in a folder).
     "outside": an always-on bot the CEO reaches through a connector; its look
     and its steps come through that connector. */
  kind?: "outside";
  /** Outside workers: the connector id they are reached through. */
  via?: string;
  hired: string;
  runtime: string;
  model: string;
  schedule: string;
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
  /** Where it ran, when not on your Mac: "Cloud · Linux". Absent = your Mac. */
  where?: string;
  /** A helper this step started (a cloud coding agent…) and where to watch it. */
  helper?: { label: string; url: string };
};

/** Something a reply carries besides prose. */
export type V3Attachment =
  | {
      kind: "pr";
      num: number;
      title: string;
      branch: string;
      add: number;
      del: number;
    }
  | {
      kind: "diff";
      path: string;
      add: number;
      del: number;
      lines: { kind: "add" | "del" | "ctx"; text: string }[];
    }
  | { kind: "image"; label: string }
  | { kind: "sheet"; name: string; rows: number };

/** One turn = one message in, the work it caused, one answer out. */
export type V3Turn = {
  n: number;
  /** "asked by CEO at 11:52". */
  from: string;
  took: string;
  /** The message that started the turn. `by` is an agent id or "you". */
  prompt?: { by: string; at: string; text: string };
  /** Folded turns show this line instead of their steps. */
  summary?: string;
  facts?: string;
  steps?: V3Step[];
  /** The agent's reply, markdown. */
  answer?: string;
  /** The answer is still being written. */
  streaming?: boolean;
  attachments?: V3Attachment[];
  /** Messages sent while this turn ran; the agent reads them after the
     current step. */
  queued?: { at: string; text: string }[];
};

/** What the (fake) agent does with one message: the steps it takes, in
   order (a run step may print output), then its answer. */
export type V3Reply = {
  steps: (V3Step & { output?: string[] })[];
  answer: string;
  attachments?: V3Attachment[];
};

/** Thread = one agent session in one folder with one model: a hand on a
   ticket, or a plain chat (no ticket) that can be turned into one. */
export type V3Thread = {
  id: string;
  /** Absent = a chat, not tied to a ticket. */
  ticketId?: string;
  /** Chats: the project whose folder the agent works in. */
  projectId?: string;
  agentId: string;
  /** This hand's job on the ticket ("Build two variants"), or the chat's topic. */
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
  /** CEO is a position: the agent holding it. Everyone else reports to it. */
  ceoId: string;
  agents: V3Agent[];
  connectors: V3ConnectorDef[];
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
  | { page: "guide" }
  | { page: "settings" }
  /** A new chat with an agent; `agentId` preselects who. */
  | { page: "chat"; agentId?: string };

/** A record: something you open (a ticket, a thread, a person, a goal, a
   project). Records open beside the page you are on, never instead of it. */
export type V3RecordRoute = Extract<V3Route, { id: string }>;

/** A page: somewhere you live (the sidebar's entries). */
export type V3PageRoute = Exclude<V3Route, V3RecordRoute>;

/** Where you are: one page, plus the records you opened from it, in order.
   The last record shows in the side peek; the rest are its trail. `full`
   widens the peek over the page without leaving it. */
export type V3Nav = {
  page: V3PageRoute;
  peek: V3RecordRoute[];
  full?: boolean;
};

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
  /** Sends a message into a thread. A finished thread starts a new turn and
     the agent answers; a working one queues it until the current step ends. */
  message: (threadId: string, text: string) => void;
  /** Opens a new chat thread with an agent in a project's folder. */
  startChat: (chat: {
    agentId: string;
    projectId: string;
    model: string;
    text: string;
  }) => void;
  markSeen: (threadId: string) => void;
  hire: (agent: { name: string; role: string; model: string }) => void;
  /** Moves the CEO position to this agent; everyone else reports to it. */
  makeCeo: (agentId: string) => void;
  /** Turns a connector on or off for one agent's sessions. */
  toggleConnector: (connectorId: string, agentId: string) => void;
  addConnector: (c: {
    label: string;
    kind: "cli" | "mcp";
    command: string;
  }) => void;
  /** Opens the ⌘K palette, optionally prefilled. */
  ask: (text?: string) => void;
};

export type V3PageProps = {
  data: V3Data;
  go: (route: V3Route) => void;
  act: V3Actions;
};
