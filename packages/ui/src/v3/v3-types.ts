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
  /* What the relay cannot tell (a runtime per agent, its schedule, skills,
     spend, memory, week) is absent, and the agent page hides that part
     instead of showing a made-up value. */
  runtime?: string;
  model: string;
  schedule?: string;
  skills?: string[];
  /** Dollars spent this period, and the cap. */
  spend?: { used: number; cap: number; period: "week" | "month" };
  instructions: string[];
  /** A rule the CEO proposes after this agent got stuck. */
  suggestion?: { text: string; after: string };
  memory?: { text: string; source: string }[];
  week?: { done: number; typical: string; stuck: number; handed: number };
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
  /** Empty when the app does not carry the conversation's turns (the real
     app shows them in its own thread view); counts and "Turn N" labels
     then stay hidden instead of reading 0. */
  turns: V3Turn[];
  step?: number;
  /** Context window used, percent; absent when the engine reports none. */
  context?: number;
  /** Absent = the engine's default model. */
  model?: string;
  /** Absent = the harness's default folder. */
  folder?: string;
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
  /** The thread's folder as it is now: what the agent changed, ran and opened. */
  workbench?: V3Workbench;
  /** The last Rewind on this thread, shown as a quiet line in the chat. */
  rewound?: { dropped: number; files: boolean };
};

/** A thread's Workbench: the same folder the agent works in, seen from
   the side (the current app's Workbench tabs, re-homed in v3). */
export type V3Workbench = {
  /** Files changed this session, with a few diff lines each. */
  diffs: {
    path: string;
    add: number;
    del: number;
    lines: { kind: "add" | "del" | "ctx"; text: string }[];
  }[];
  /** Every path in the folder ("src/app.ts"); folders end with "/". */
  files: string[];
  /** What a few files say, for the Files viewer. */
  fileText: Record<string, string>;
  /** The agent's terminals: each command and its output. */
  terminal: { cmd: string; lines: string[]; running?: boolean }[];
  /** A dev server the agent started, shown in Preview. */
  preview?: { url: string; title: string };
  /** The branch's pull request, once opened. */
  pr?: {
    num: number;
    title: string;
    state: "draft" | "open" | "merged";
    checks: "running" | "passing" | "failing";
  };
  /** Long commands left running in the background. */
  jobs: { cmd: string; state: "running" | "done" | "failed"; tail: string }[];
};

/** One tab in the LilOS Browser: yours, or one an agent drives. */
export type V3BrowserTab = {
  id: string;
  title: string;
  url: string;
  /** "you", or the agent id driving it. */
  by: string;
  /** Agent tabs: the thread it belongs to. */
  threadId?: string;
  /** Agent tabs: what it is doing now ("Reading posts"). */
  doing?: string;
  /** You took the tab over from its agent; it waits until you hand it back. */
  takenOver?: boolean;
  /** A few lines of the page, so the prototype has something to show. The
     real browser draws its pages natively, so the app leaves this out. */
  page?: string[];
};

export type V3ScheduleWhen = {
  kind: "hourly" | "daily" | "weekdays" | "weekly" | "once" | "cron";
  /** "HH:MM" (hourly reads only the minutes). */
  time: string;
  /** weekly: 0–6 = Sun–Sat. */
  day?: number;
  /** once: "YYYY-MM-DD". */
  date?: string;
  /** cron: five fields, for anything the presets can't say. */
  cron?: string;
};

/** A job an agent runs by itself on a schedule; each run is a new thread. */
export type V3Schedule = {
  id: string;
  agentId: string;
  projectId?: string;
  /** The folder a run opens in, when it is not a project's. */
  folder?: string;
  title: string;
  /** What the agent is told each time. */
  prompt: string;
  when: V3ScheduleWhen;
  /** Next run, in words ("Tomorrow 09:00"). */
  next: string;
  paused?: boolean;
  /** Runs without asking before risky commands: nobody is there at 2am
     to approve, so the schedule says up front what it may do. */
  fullAccess?: boolean;
  last?: {
    at: string;
    result: "running" | "finished" | "failed";
    threadId?: string;
  };
  /** When a run was skipped because the one before was still going. */
  skipped?: string;
};

/** A phone paired with this Mac. */
export type V3Device = {
  id: string;
  name: string;
  /** Absent when the Mac cannot tell (the relay records no hardware). */
  model?: string;
  lastSeen: string;
};

/** What a phone scans (and the same facts to type by hand). */
export type V3PairOffer = {
  /** Where the phone dials. */
  host: string;
  /** The one-time grant; the only secret. */
  code: string;
  /** What the QR encodes. */
  url: string;
  /** Epoch ms; absent = does not expire. */
  expiresAt?: number;
};

export type V3Pairing =
  | { kind: "ready"; offer: V3PairOffer }
  /** This Mac is not reachable from a phone yet. */
  | { kind: "no-remote" };

/** One engine profile's connection to LilOS (the approval that lets its
   agents see the app). */
export type V3ConnectRow = {
  profile: string;
  employee?: string;
  state: "connected" | "not-connected" | "updating" | "failed";
  reason?: string;
};

export type V3Settings = {
  /** What the phone is told about. Absent: the app sends no pushes, so
     there is nothing to choose. */
  push?: {
    needsYou: boolean;
    finished: boolean;
    stuck: boolean;
    failed: boolean;
  };
  /** Ask before risky commands, or let agents run anything. */
  approvals: "ask" | "full";
  /** Where "Open in editor" goes (its name). Absent: no editor found. */
  editor?: string;
  /** Editors this Mac has, by name; absent: nothing to choose. */
  editors?: string[];
  /** Models the pickers offer; `group` names the provider when the engine
     has several. Empty: the engine reports no catalog. */
  models: { id: string; label: string; on: boolean; group?: string }[];
  engine: {
    name: string;
    /** Absent until the engine has said. */
    version?: string;
    /** ok · missing: not installed · old: below the minimum version ·
       starting: coming up, nothing to do yet · down: installed but not
       running (see `problem`). */
    state: "ok" | "missing" | "old" | "starting" | "down";
    /** Absent where the app cannot tell where it lives. */
    path?: string;
    /** What is wrong in plain words, with the next step, as the engine
       reported it; replaces the generic steps. */
    problem?: string;
  };
  /** The link between this app and the engine. */
  relay: { state: "ok" | "starting" | "down"; problem?: string };
  /** This app's own version line; absent where it has none to show. */
  about?: {
    version: string;
    /** A question for the CEO about what changed; absent = no such row. */
    whatsNew?: { label: string; ask: string };
  };
  /** Everything worth pasting into a bug report; absent = built from what
     is on screen. */
  diagnostics?: string;
  /** Engine profiles and whether LilOS is connected to them; absent when
     the engine has no such step. */
  connect?: { engine: string; approved: boolean; rows: V3ConnectRow[] };
  /** What first run offers: models and folders with a line about each.
     An absent or empty list hides that choice. */
  firstRun?: {
    models: { label: string; note?: string }[];
    folders: { path: string; note?: string }[];
  };
};

export type V3Ask = {
  id: string;
  /** Absent when the ask belongs to a chat, not a ticket. */
  ticketId?: string;
  /** The thread the agent asked in; the Needs page opens it when there is
     no ticket. */
  threadId?: string;
  from: string;
  kind: "approval" | "question";
  title: string;
  /** Minutes waiting. */
  waiting: number;
  ask: string;
  /* The agent's own reasons and what each answer would do come from the
     CEO's briefing; without one these stay absent and the page hides them. */
  why?: string;
  ifYes?: string;
  ifNo?: string;
  spend?: { amount: number; used: number; cap: number };
  /** Offered as "let this agent do it without asking next time". */
  allowRule?: string;
  /** Question answers; the first is what happens by default. */
  options?: string[];
  /** If you don't answer by `at`, the CEO does this. */
  fallback?: { at: string; does: string };
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
  /** CEO is a position: the agent holding it. Everyone else reports to it.
     Absent when the company has no such position (the real app has none
     yet): no crown, no "reports to", no "Make CEO", and new chats start
     with the first agent. */
  ceoId?: string;
  agents: V3Agent[];
  connectors: V3ConnectorDef[];
  projects: V3Project[];
  goals: V3Goal[];
  tickets: V3Ticket[];
  threads: V3Thread[];
  asks: V3Ask[];
  updates: V3Update[];
  schedules: V3Schedule[];
  browser: {
    tabs: V3BrowserTab[];
    bookmarks: { title: string; url: string }[];
  };
  devices: V3Device[];
  /** Models the new-chat and hire pickers offer, as the picker shows them
     (the app turns a pick back into a real model when it acts on it). */
  modelChoices: string[];
  /** Openers a new chat offers as one-click prompts. Absent: none (the
     real app has no source for them yet). */
  starters?: string[];
  /** Folders a new chat can work in when the company has no projects yet:
     the app's recent folders. Absent = no folder choice. */
  folders?: { path: string; label: string }[];
  settings: V3Settings;
  /** The company is set up; false shows the first-run welcome. */
  setUp: boolean;
  /** What this company has switched on. `tickets` (M2): Work, Goals, Inbox
     and the CEO's update; off, those stay out of sight rather than empty. */
  features: { tickets: boolean };
};

export type V3Route =
  | { page: "home" }
  | { page: "needs" }
  | { page: "inbox" }
  | { page: "work"; view?: "waiting" | "board" | "project" | "timeline" }
  | { page: "ticket"; id: string }
  | { page: "threads"; view?: "live" | "all" | "agent" | "scheduled" }
  | { page: "thread"; id: string }
  | { page: "goals" }
  | { page: "goal"; id: string }
  | { page: "project"; id: string }
  | { page: "people"; view?: "table" | "org" }
  | { page: "agent"; id: string }
  | { page: "hire" }
  | { page: "guide" }
  | { page: "settings"; view?: "general" | "engine" | "phone" | "connectors" }
  /** First run: name the company, check the engine, hire the CEO, add a project. */
  | { page: "welcome" }
  /** A new chat, opened like any record beside the page you are on; `id` is
     the agent it starts with (you already chose who, so no picker first). */
  | { page: "newchat"; id: string };

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

/** Everything a page can change; the shell owns the state. An action the app
   has no backend for is absent (marked `?`), and the control that would call
   it is not drawn: capability by presence, never a button that does nothing. */
export type V3Actions = {
  approve: (askId: string, alwaysAllow?: boolean) => void;
  deny: (askId: string) => void;
  answer: (askId: string, option: string) => void;
  stop: (threadId: string) => void;
  handOff?: (ticketId: string, agentId: string) => void;
  acceptRule?: (agentId: string) => void;
  dismissRule?: (agentId: string) => void;
  comment?: (ticketId: string, text: string) => void;
  /** Sends a message into a thread. A finished thread starts a new turn and
     the agent answers; a working one queues it until the current step ends. */
  message: (threadId: string, text: string) => void;
  /** Opens a new chat thread with an agent and returns its id, so the caller
     can show it where the draft was. Resolves undefined when the chat could
     not start (the app has already said why); the draft stays. `folder` is a
     path from `data.folders`, for a company without projects. */
  startChat: (chat: {
    agentId: string;
    projectId?: string;
    folder?: string;
    model: string;
    text: string;
  }) => Promise<string | undefined>;
  markSeen: (threadId: string) => void;
  /** Hires an agent and returns its id, so the Hire page can open it. Rejects
     when the hire failed (the app has already said why). Absent while the
     engine cannot create agents. */
  hire?: (agent: {
    name: string;
    role: string;
    model: string;
  }) => Promise<string>;
  /** Starts a ⌘K draft plan: its tickets (and the threads that can start now). */
  startPlan?: (plan: Extract<V3Draft, { kind: "plan" }>, text: string) => void;
  /** Moves the CEO position to this agent; everyone else reports to it. */
  makeCeo?: (agentId: string) => void;
  /** Turns a connector on or off for one agent's sessions. */
  toggleConnector?: (connectorId: string, agentId: string) => void;
  addConnector?: (c: {
    label: string;
    kind: "cli" | "mcp";
    command: string;
  }) => void;
  /** Undo files and conversation back to before this turn's message. */
  rewind?: (threadId: string, turn: number) => void;
  scheduleSave: (s: V3Schedule) => void;
  scheduleToggle: (id: string) => void;
  scheduleRunNow: (id: string) => void;
  scheduleDelete: (id: string) => void;
  /** Opens a tab in a session's browser (yours, so the agent can see it).
     Absent without the desktop browser. */
  browserOpen?: (url: string, threadId: string) => void;
  browserClose?: (tabId: string) => void;
  /** Take a tab from its agent (it pauses), or hand it back. */
  browserTakeOver?: (tabId: string) => void;
  /** Mints a one-time pairing offer for the phone to scan. Resolves
     `no-remote` when this Mac is not reachable from a phone (nothing to
     show but what to turn on); rejects when the offer could not be made (the
     app has already said why). The pane sees the phone arrive in
     `data.devices`. */
  pairPhone: () => Promise<V3Pairing>;
  unpairPhone: (deviceId: string) => void;
  /** Closes the door pairing opened: no phone reaches this Mac until the
     next offer. Absent when the app cannot. */
  disablePhoneAccess?: () => void;
  saveSettings: (patch: Partial<V3Settings>) => void;
  /** Renames the company and/or you, in place. Absent where the CEO changes
     them through ⌘K instead (or nobody can). */
  saveProfile?: (p: { company?: string; me?: string }) => void;
  /** Re-reads the relay and engine; resolves when the answer is in
     `settings.relay` / `settings.engine`. Absent: no Check again. */
  checkEngine?: () => Promise<void>;
  /** Asks the shell's updater; resolves with what it found, in words.
     Absent where the app cannot update itself (the web build). */
  checkUpdates?: () => Promise<string>;
  /** The one-time approval that lets the engine's agents see the app;
     rows update in `settings.connect`. Absent without engine support. */
  connectEngine?: () => Promise<void>;
  /** First run done: the company exists and the app opens on Home. The
     agent is the first one hired (the CEO, where the company has one); a
     name or model left out keeps what the engine started it with, and no
     folder means the first chat picks one. Rejects only if nothing could be
     saved: the welcome says so and stays open. */
  finishSetup: (s: {
    company: string;
    me: string;
    agentName?: string;
    agentModel?: string;
    folder?: string;
  }) => void | Promise<void>;
  /** Leaves first run for now (Settings can fix what blocked it). Absent in
     the prototype, where there is nothing to be stuck on. */
  skipSetup?: () => void;
  /** Opens the ⌘K palette, optionally prefilled. */
  ask: (text?: string) => void;
};

/** What the app hands the shell: every action except opening ⌘K, which the
   shell owns. The prototype backs these with its mock engine; the real app
   with relay calls. */
export type V3DataActions = Omit<V3Actions, "ask">;

export type V3PageProps = {
  data: V3Data;
  go: (route: V3Route) => void;
  act: V3Actions;
};
