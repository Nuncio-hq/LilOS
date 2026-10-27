/* Where you are and what a page may do: the routes, the nav state, every
   action the app can back (absent = not drawn), and the props every page
   takes. */

import type {
  AttachedFile,
  ConversationAccess,
  FileMention,
  ModelChoice,
  ModelVisibility,
  SlashItem,
} from "../types";
import type {
  V3Data,
  V3Draft,
  V3Pairing,
  V3Schedule,
  V3Settings,
} from "./v3-data-types";
import type { V3AgentPatch, V3MessageHit, V3Profile } from "./v3-types";

export type V3Route =
  | { page: "home" }
  | { page: "needs" }
  | { page: "inbox" }
  | { page: "work"; view?: "waiting" | "board" | "project" | "timeline" }
  | { page: "ticket"; id: string }
  | { page: "threads"; view?: "scheduled" }
  | { page: "thread"; id: string }
  | { page: "goals" }
  | { page: "goal"; id: string }
  | { page: "project"; id: string }
  | { page: "people"; view?: "table" | "org" }
  | { page: "agent"; id: string }
  | { page: "hire" }
  | { page: "guide" }
  | {
      page: "settings";
      view?: "general" | "engine" | "phone" | "connectors" | "skills";
    }
  /** First run: your name, the first agent, a project folder. */
  | { page: "welcome" }
  /** A new chat, opened like any record beside the page you are on; `id` is
     the agent it starts with (you already chose who, so no picker first). */
  | { page: "newchat"; id: string };

/** A record: something you open (a ticket, a thread, a person, a goal, a
   project). A record becomes the page when you go to it (the sidebar, ⌘K);
   a record the page already lists opens beside it (D-#769). */
export type V3RecordRoute = Extract<V3Route, { id: string }>;

/** A page: somewhere you live, that carries no id of its own. */
export type V3PageRoute = Exclude<V3Route, V3RecordRoute>;

/** Where you are: one route you went to (a page, or the record itself when
   a sidebar item or ⌘K jump navigated, D-#769), plus the records you opened
   from it, in order. The last record shows in the side peek; the rest are
   its trail. `full` widens the peek over the page without leaving it — and
   on a thread page it is the session view. */
export type V3Nav = {
  page: V3Route;
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
  /** Marks a ticket done (`tickets.update`). Absent = the button is not drawn. */
  markDone?: (ticketId: string) => void;
  acceptRule?: (agentId: string) => void;
  dismissRule?: (agentId: string) => void;
  comment?: (ticketId: string, text: string) => void;
  /** Sends a message into a thread. A finished thread starts a new turn and
     the agent answers; a working one queues it until the current step ends. */
  message: (threadId: string, text: string) => void;
  /** Opens a new chat thread with an agent and returns its id, so the caller
     can show it where the draft was. Resolves undefined when the chat could
     not start (the app has already said why); the draft stays. `projectId`
     is the picked project and `folder` its folder: the app sends the folder
     (the relay files the thread under the project that owns it, D-#771),
     and both are absent for a plain chat, which works in no folder. `files`
     are what was attached (bytes as data URLs, like the chat composer's);
     `text` may then be empty. */
  startChat: (chat: {
    agentId: string;
    projectId?: string;
    folder?: string;
    model: string;
    /** What the model picker chose (model, provider, effort, Fast), when the
       app offers one (`data.modelCatalog`); `model` is then only its label. */
    pick?: ModelChoice;
    /** The access level the chat opens on, when the app offers the pill. */
    access?: ConversationAccess;
    text: string;
    files?: AttachedFile[];
  }) => Promise<string | undefined>;
  /** Files and folders of `folder` matching what follows an `@` in a new
     chat's box. Absent: `@` offers people only. */
  searchFiles?: (folder: string, query: string) => Promise<FileMention[]>;
  /** The engine's commands and skills matching what follows a leading `/` in
     a new chat's box, for this agent (and folder, if one is chosen). Absent:
     `/` stays plain text. */
  searchCommands?: (
    scope: { agentId: string; folder?: string },
    query: string,
  ) => Promise<SlashItem[]>;
  /** Writes the Edit models list the model picker offers (the app persists
     it). Absent: the picker has no Edit models. */
  setModelVisibility?: (v: ModelVisibility) => void;
  /** Re-reads the engine's model catalog; rejects when it failed (the app has
     already said why). Present only where `modelCatalog.refreshable`. */
  refreshModels?: () => Promise<void>;
  /** "New project from a folder…": the app asks for a folder (its own
     dialog), makes a project of it (a folder that already has one answers
     that project) and calls `onCreated` with its id once it is in
     `data.projects`. Closing the dialog says nothing. Absent: the project
     menu has no such row. */
  newProject?: (onCreated: (projectId: string) => void) => void;
  markSeen: (threadId: string) => void;
  /** Opens the app's small add-agent dialog (the ＋ beside Agents, "Add
     agent…" at the bottom of a composer's agent menu — #870): Who? · Name ·
     Hire, nothing else. `onHired` gets the new agent's id — the caller
     selects it where it was opened (its composer, a new chat). Absent: no
     ＋ and no menu row (the app cannot create agents). */
  addAgent?: (onHired: (agentId: string) => void) => void;
  /** Hires an agent and returns its id, so the Hire page can open it. Rejects
     when the hire failed (the app has already said why). Absent while the
     engine cannot create agents. `runtime` lands the new profile on that
     engine runtime (D-#761); absent = the default engine. */
  hire?: (agent: {
    name: string;
    role: string;
    /** "" = the engine/runtime's own default model (the add-agent dialog
        asks for no model). */
    model: string;
    runtime?: string;
  }) => Promise<string>;
  /** The engine's profiles, read fresh each time the Hire page opens so one
     made or freed elsewhere shows up. Absent where the engine cannot list
     them: the Hire page then has no second section. */
  listProfiles?: () => Promise<V3Profile[]>;
  /** Hires an agent onto an engine profile that already exists: the agent
     keeps the profile's own persona and model (the engine owns them) and the
     profile is never changed. Resolves with the new agent's id; rejects when
     the hire failed (the app has already said why). Absent while the engine
     cannot create agents. */
  hireProfile?: (agent: {
    profile: string;
    name: string;
    role: string;
    runtime?: string;
  }) => Promise<string>;
  /** Starts a ⌘K draft plan: its tickets (and the threads that can start now). */
  startPlan?: (plan: Extract<V3Draft, { kind: "plan" }>, text: string) => void;
  /** Moves the CEO position to this agent (D-#778). The relay re-points
      who reported to the previous holder or to the owner; a deeper link stays. */
  makeCeo?: (agentId: string) => void;
  /** Saves what changed on an agent: only the fields in `patch` are written.
     Resolves with `confirmModel` (the engine's words) when the engine held a
     new model back until it is confirmed; everything else in the patch is
     already saved then, and the model is sent again with `confirmModel: true`
     once you agree. Rejects when nothing could be saved (the app has already
     said why). Absent where the app cannot edit agents. */
  updateAgent?: (
    id: string,
    patch: V3AgentPatch,
  ) => Promise<{ confirmModel?: string } | undefined>;
  /** Takes an agent off the team, and with it its threads and scheduled jobs;
     tickets it owned stay and read "Former agent". The engine's own profile
     is never touched. Rejects when it could not be removed (the app has
     already said why). Absent where the app cannot. */
  removeAgent?: (id: string) => Promise<void>;
  /** Turns a connector on or off for one agent's sessions. */
  toggleConnector?: (connectorId: string, agentId: string) => void;
  /** Writes one memory file. `id` replaces that note; absent adds one.
      Absent: the page draws no Notes section (D-#19). */
  saveNote?: (
    agentId: string,
    note: { id?: string; name: string; text: string },
  ) => void;
  /** Attaches or detaches one company skill for this agent. Absent: skills
      stay a quiet list, with no toggle (D-#19). */
  setAgentSkill?: (agentId: string, skillId: string, attached: boolean) => void;
  /** Adds a skill to the company library. The page has already read a chosen
      file into `text`, or the words were typed. Absent: Settings has no
      Skills tab (D-#19). */
  addSkill?: (skill: { name: string; about: string; text: string }) => void;
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
  /** Opens the app's system status (relay → harness → engine → model, one
     line each, with the diagnostics to copy) over whatever is on screen.
     Absent where the app has no such view. */
  showStatus?: () => void;
  /** Asks the shell's updater; resolves with what it found, in words.
     Absent where the app cannot update itself (the web build). */
  checkUpdates?: () => Promise<string>;
  /** The one-time approval that lets the engine's agents see the app;
     rows update in `settings.connect`. Absent without engine support. */
  connectEngine?: () => Promise<void>;
  /** #884: the one-click repair for an engine reporting `off` — sets its
     global policy to `smart` once (the Settings warning, the access
     pill's menu). Absent where the app can't reach the engine. */
  fixEnginePolicy?: () => void;
  /** "Choose folder…" in first run (#885): the app opens its own folder
     picker (the same one a new chat's project menu uses) and `onPicked`
     gets the path, which lands in the typed field — a path from typing
     stays the fallback. Absent: no button, typing only. */
  pickFolder?: (onPicked: (path: string) => void) => void;
  /** First run done: the app opens on Home. The agent is the first one
     (the CEO, where the company has one); a name or model left out keeps
     what the engine started it with, and no folder means the first chat
     picks one. Rejects only if nothing could be saved: the welcome says so
     and stays open. */
  finishSetup: (s: {
    me: string;
    agentName?: string;
    agentModel?: string;
    folder?: string;
  }) => void | Promise<void>;
  /** Leaves first run for now (Settings can fix what blocked it). Absent in
     the prototype, where there is nothing to be stuck on. */
  skipSetup?: () => void;
  /** Renames a thread in place (an empty title is not a rename). Absent: the
     app cannot, and no title is editable. */
  renameThread?: (threadId: string, title: string) => void;
  /** Settles a thread (`true`: it leaves every list for the Done shelf —
     finished work parked, not deleted — and settling takes its pin off) or
     brings it back to the top of Active. The wire keeps the name
     `archiveThread` until the backend slice renames archive to settle
     (#862); the UI says Done / Not done (#887). Absent: no done controls. */
  archiveThread?: (threadId: string, archived: boolean) => void;
  /** Pins a thread to the top of the list (`true`) or takes the pin off.
     Absent: no pin controls. */
  pinThread?: (threadId: string, pinned: boolean) => void;
  /** Snoozes a thread until `until` (epoch ms): it keeps working but leaves
     every list until then — or until it needs you, fails or gets stuck, or
     you message it. Absent: no Snooze. */
  snoozeThread?: (threadId: string, until: number) => void;
  /** Brings a snoozed thread back now ("Wake now"): the snooze is over, it
     returns to where it belongs. Absent: no Wake control. */
  wakeThread?: (threadId: string) => void;
  /** The per-thread auto-settle flag: `false`, the 3-day-idle and
     PR-merged sweep leaves this thread alone. The desktop menu dropped its
     switch (#887); the relay keeps the field and the default stays on. */
  setAutoSettle?: (threadId: string, enabled: boolean) => void;
  /** ⌘K's message search: what people and agents said, newest relevance
     first. Rejects when the search failed (the app has already said why).
     Absent: ⌘K finds people, threads and records only. */
  searchMessages?: (query: string) => Promise<V3MessageHit[]>;
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
