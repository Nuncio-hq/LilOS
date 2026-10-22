/* UX v3 view models (prototype): the company as three databases (People,
   Work, Goals) in a calm, Notion-like layout. Every row answers who holds it,
   what state it is in, since when, and what it waits on. Not wire types.
   This file holds the records themselves (agents, tickets, threads and what a
   thread carries); v3-data-types the company around them (schedules, phone,
   settings, the whole `V3Data`); v3-page-types where you are and what a page
   may change. */

import type { AttachedFile } from "../types";

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

/** A memory file the agent keeps. The company owns the file; a runtime only
    sees a copy for the live thread. The row is this file: its name, the
    first line of `text` (so an edit cannot drift from a second list), and
    `updated` for where it came from. */
export type V3Note = {
  id: string;
  /** File name, as the list shows it ("readers.md"). */
  name: string;
  text: string;
  /** Where it came from, as the row shows it: a ticket ("from LIL-77") or
      a date ("9 Oct", "just now"). */
  updated: string;
};

/** One skill in the company library. An agent uses the ones it has attached. */
export type V3Skill = {
  id: string;
  name: string;
  /** One line, for the library list. */
  about: string;
  /** The text a runtime is given when this skill is attached. */
  text: string;
};

export type V3Agent = {
  id: string;
  name: string;
  /** Avatar colour. */
  tone: V3Tone;
  role: string;
  /** Employee id this agent reports to. Absent, or an id that is gone:
      the owner, shown by the profile name (D-#775). */
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
  /** The engine profile the agent runs on (its id on the engine), where the
     app knows it. The profile is which runtime. Instructions, notes and
     skills are the company's, when the app carries them. */
  profile?: string;
  model: string;
  /** The model's id on the engine, where `model` (the label) names one: the
     new-chat picker starts on it with its own effort. Absent: the engine's
     default model. */
  modelId?: string;
  /** Your newest chat with this agent, by when it began: the project it
     lived in (absent = a plain chat) and the first message you wrote, as you
     wrote it. The next new chat starts in the same project (or none), and ↑
     in its empty box brings the message back. Absent: no chat yet. */
  lastChat?: { projectId?: string; opener?: string };
  /** What the agent is for, in a line: the engine profile's description,
     where the engine lets the app write one. Absent: none set. */
  description?: string;
  /** Notifications switched off for this agent (banners and pushes alike). */
  muted?: boolean;
  schedule?: string;
  /** Skill ids this agent uses. When the company library is present
      (`V3Data.skills`) each id is one of its skills and the page can attach
      or detach it. With no library, the page shows the names and no control. */
  skills?: string[];
  /** Memory files (the agent's notes/). Absent: this app does not carry
      them, and the page draws no Notes section (D-#19). */
  notes?: V3Note[];
  /** Dollars spent this period, and the cap. */
  spend?: { used: number; cap: number; period: "week" | "month" };
  instructions: string[];
  /** A rule the CEO proposes after this agent got stuck. */
  suggestion?: { text: string; after: string };
  week?: { done: number; typical: string; stuck: number; handed: number };
  /** Threads finished or failed since Monday, and threads whose stuckAt
      falls in that week even after they recover. Colour is only a count
      above zero. */
  weekThreads?: { finished: number; failed: number; stuck: number };
  /** Idle agents: what wakes them next. */
  next?: string;
};

/** An edit to an agent: only the fields present are written. `muted` is
   notifications switched off; `confirmModel` re-sends a model the engine held
   back for a confirm. */
export type V3AgentPatch = {
  name?: string;
  role?: string;
  description?: string;
  model?: string;
  instructions?: string;
  muted?: boolean;
  confirmModel?: boolean;
};

/** An engine profile as the engine reports it: a persona with a model and
   skills that exists on the engine whether or not anyone is hired on it. The
   Hire page offers the ones no agent runs yet. */
export type V3Profile = {
  /** The profile's id on the engine; an agent's `profile` names it. */
  id: string;
  /** The name the engine shows for it. */
  name: string;
  /** What the engine says it is for, in a line, if it says. */
  description?: string;
  /** Its own model, as the pickers label it; absent when it sets none. */
  model?: string;
  skills: number;
  /** Its persona text, if the engine describes it. */
  soul?: string;
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
  | { kind: "ticket"; ticketId: string }
  /** The role, not a person. Shown as whoever holds the seat. */
  | { kind: "ceo" };

export type V3ProgressStep = {
  text: string;
  by: string;
  took: string;
  state: "done" | "current" | "todo";
};

export type V3Comment = {
  /** `system` is LilOS and names nobody. Absent is a person: `by` names them. */
  authorKind?: "user" | "employee" | "system";
  /** Agent id, or "you". Absent for a system note. */
  by?: string;
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
  /** The message that started the turn. `by` is an agent id or "you";
     `files` are what you attached to it (text may then be empty). */
  prompt?: { by: string; at: string; text: string; files?: AttachedFile[] };
  /** What a turn that has no answer did, in one line. */
  summary?: string;
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
  /** The project the thread lives in (D-#771), whose folder the agent works
     in; absent = a plain chat, which works in no folder. */
  projectId?: string;
  agentId: string;
  /** This hand's job on the ticket ("Build two variants"), or the chat's topic. */
  title: string;
  status: V3Status;
  /** Finished since you last looked. */
  unseen?: boolean;
  /** Minutes since this thread finished. Needs you sorts finished-not-seen
     rows by this; a ticket's age is a different clock and may be absent. */
  doneAgo?: number;
  startedAt: string;
  /** When the thread opened, epoch ms. Hands that share a clock minute
      sort by this so the chain stays oldest first (D-#776). */
  openedAt?: number;
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
  helpers?: { text: string; took: string }[];
  /** The thread's folder as it is now: what the agent changed, ran and opened. */
  workbench?: V3Workbench;
  /** The last Rewind on this thread, shown as a quiet line in the chat. */
  rewound?: { dropped: number; files: boolean };
};

/** One message that matched a ⌘K search. The thread's title and whether it
   is archived come from `data.threads` / `data.archivedThreads`. */
export type V3MessageHit = {
  messageId: string;
  threadId: string;
  /** Who wrote it: an agent id, "you", or "system" (a note LilOS itself wrote). */
  by: string;
  at: string;
  /** An excerpt with `<mark>` around the matched words. Parsed back into
     elements, never set as HTML. */
  snippet: string;
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
