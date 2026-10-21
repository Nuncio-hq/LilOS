/* The company around the records: schedules, the phone, settings, what waits
   on you, the CEO's drafts, and `V3Data`, everything a page reads. */

import type { ModelOption, ModelProvider, ModelVisibility } from "../types";
import type { V3HireTemplate } from "./hire-templates";
import type {
  V3Agent,
  V3BrowserTab,
  V3ConnectorDef,
  V3Goal,
  V3Project,
  V3Thread,
  V3Ticket,
} from "./v3-types";

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
  /** Next run, in words ("Tomorrow 09:00"). Display only. */
  next: string;
  /** That same run, epoch ms. Absent when it will not run again. Lists
      order by this, never by the words in `next` (D-#774). */
  nextAt?: number;
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
  /** What the phone is told about. A missing key is a kind this app does
     not offer here (D-#19). The phone owns these, Stuck included (D-#772);
     this Mac does not offer a Stuck switch. Absent entirely: no section. */
  push?: {
    needsYou?: boolean;
    finished?: boolean;
    failed?: boolean;
  };
  /** Ask before risky commands, or let agents run anything. */
  approvals: "ask" | "full";
  /** The engine's own approval policy, under the default above: smart runs
     routine steps and asks for risky ones, manual asks every time, off never
     asks. Absent: this engine has no such setting, so there is nothing to
     choose. Written through `saveSettings({ enginePolicy })`. */
  enginePolicy?: "smart" | "manual" | "off";
  /** Where "Open in editor" goes (its name). Absent: no editor found. */
  editor?: string;
  /** Editors this Mac has, by name; absent: nothing to choose. */
  editors?: string[];
  /** Models the pickers offer; `group` names the provider when the engine
     has several. Empty: the engine reports no catalog. */
  models: { id: string; label: string; on: boolean; group?: string }[];
  engine: {
    name: string;
    /** True while `name` is only a placeholder: the engine has not said who
       it is yet. Absent: `name` is the engine's own. */
    unnamed?: boolean;
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
  /** Minutes waiting. Prototype rows sort by this when `at` is absent. */
  waiting: number;
  /** When the ask opened (ms). Real asks sort by this, oldest first. */
  at?: number;
  ask: string;
  /* Lines the ask carries. A gateway ask may set them; an engine approval
     leaves them absent and the page hides the rows. */
  why?: string;
  ifYes?: string;
  ifNo?: string;
  spend?: { amount: number; used: number; cap: number };
  /** Shown only when the engine offers to allow the command next time. */
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
  /** CEO is a position: the agent holding it, shown with a crown (D-#778).
      Who someone reports to is `reportsTo` (D-#775), not this position.
      Absent when the company has nobody in it yet: no crown, and ⌘K only
      searches. New chats start with the holder when there is one. */
  ceoId?: string;
  agents: V3Agent[];
  connectors: V3ConnectorDef[];
  projects: V3Project[];
  goals: V3Goal[];
  tickets: V3Ticket[];
  threads: V3Thread[];
  /** Threads put away, newest first. They are not in `threads`, so Live, the
     sidebar and every agent's page forget them; Threads → All lists them
     under "Archived", where they unarchive. Absent: the app has no archive. */
  archivedThreads?: V3Thread[];
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
  /** Hire cards. The same list the app uses for a new agent's instructions,
      so the role on the card is the role that gets stored. */
  hireTemplates: V3HireTemplate[];
  /** What the app may write on an agent's page, beyond name, role and
     notifications (which it always can when it can edit at all): the engine
     lists the profile fields it accepts. Absent or empty: only those three. */
  agentFields?: ("description" | "model" | "instructions")[];
  /** Openers a new chat offers as one-click prompts. Absent: none (the
     real app has no source for them yet). */
  starters?: string[];
  /** What the app knows of the folders it has been given (its recents):
     what a project's folder looks like in the new chat's box (its branch),
     and the places a schedule can run in when the company has no projects
     yet. Absent = nothing known. Unreachable folders are left out. */
  folders?: {
    path: string;
    label: string;
    /** The repo's checked-out branch; `null` = not a git repo (the box then
       says "direct · no git"); absent = not known, nothing is said. */
    branch?: string | null;
  }[];
  /** The model picker the new-chat box shows instead of the plain model menu:
     the engine's whole catalog with each model's effort ladder and Fast tier,
     what the engine runs by default, and what Edit models has hidden (the
     picker applies it). Absent: the plain menu over `modelChoices`. */
  modelCatalog?: {
    options: ModelOption[];
    defaultModel?: string;
    defaultProvider?: string;
    providers?: ModelProvider[];
    visibility?: ModelVisibility;
    /** The engine can re-read its catalog (`refreshModels`). */
    refreshable?: boolean;
  };
  /** The app starts a chat on the access you pick (Ask / Full access): the
     new-chat box shows the pill, starting on `settings.approvals`. Absent: no
     pill; the chat opens on that default. */
  chatAccess?: boolean;
  /** What a message may carry (the wire's caps). Absent = the app sends no
     files: the new-chat draft draws no attach control. */
  attachLimits?: { maxFileBytes: number; maxFiles: number };
  settings: V3Settings;
  /** The company is set up; false shows the first-run welcome. */
  setUp: boolean;
  /** What this company has switched on. `tickets` (M2): Work, Goals, Inbox
     and the CEO's update; off, those stay out of sight rather than empty. */
  features: { tickets: boolean };
};
