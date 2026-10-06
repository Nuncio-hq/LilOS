/* Domain types for the LilOS UI surfaces. Presentational props speak these; the prototype's mock data
   (and, later, the relay wire types in packages/contracts) produce them. Wire types are NOT defined here —
   this file is the UI contract only (issue #12; wire schemas live in packages/contracts). */

import type { ReactNode } from "react";

export type Status = "online" | "busy" | "offline";
export type RespondTo = "me" | "selected" | "anyone";
export type Employee = {
  id: string;
  name: string;
  role: string;
  status: Status;
  profile: string;
  model: string;
  now: string;
  instructions: string;
  respondTo: RespondTo;
};
export type Channel = {
  id: string;
  name: string;
  repo?: string;
  unread?: number;
  employees: string[];
  dm?: boolean;
};
export type Project = {
  id: string;
  name: string;
  key: string;
  channels: Channel[];
};
export type Diff = {
  path: string;
  status: "added" | "modified" | "deleted";
  add: number;
  del: number;
  patch: string;
};
/* A pinned review note on a Changes diff line or range (issue #108).
   `side` says which gutter the anchor lives on: "b" = new-file lines
   (added/context rows), "a" = old-file lines (deleted rows exist only
   there). `start`/`end` are that side's line numbers, `lines` snapshots
   the quoted text with its +/-/space diff marker so the sent message
   stays honest if the file later shifts. `patch` fingerprints the diff
   the note was sent against — resolved markers drop once it changes
   (AC-4). */
export type DiffComment = {
  id: string;
  path: string;
  side: "a" | "b";
  start: number;
  end: number;
  /** The anchor rows' displayed text, +/-/space-prefixed, at pin time. */
  lines: string[];
  text: string;
  resolved?: boolean;
  patch?: string;
  /** The route the send took — the resolved marker's "Sent · …" pill
      mirrors the toast's wording (issue #393 AC-2). */
  via?: "prompt" | "steer" | "queue";
};
export type GitCommit = {
  hash: string;
  message: string;
  /** The commit's real git author — live rows come from `git.log`; mock
      rows leave it off and the row falls back to the employee name (#587). */
  author?: string;
  files: { path: string; status: Diff["status"]; add: number; del: number }[];
};
/* A step = one Hermes tool call (tool.start → tool.complete). The workbench is derived only from steps:
   inline_diff → Changes, terminal output → Terminal, git commit → Commits. */
export type Step = {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  running?: boolean;
  /** Wire completion state (engine tool.completed); absent on mock steps,
      which read as completed. Drives the #416 changed-file count: a denied
      or failed write changed nothing, so its input path must not count. */
  status?: "running" | "completed" | "failed" | "denied" | "cancelled";
  /** A delegate_task that closed on its dispatch receipt while the helper
     it spawned still runs (#309) — the step reads "Dispatched", not
     "Completed". */
  dispatched?: boolean;
  diff?: Diff;
  commit?: GitCommit;
};
/* Hermes todo tool (todo.updated) statuses */
export type Todo = {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
};
/* phase mirrors the Hermes turn events: message.start → submitted, reasoning.delta → thinking,
   tool.start/complete → tools, message.delta → typing, message.complete → done, session.interrupt → stopped,
   message.complete with an error → failed */
export type Phase =
  | "submitted"
  | "thinking"
  | "tools"
  | "waiting"
  | "typing"
  | "done"
  | "stopped"
  | "failed";
/**
 * A file the composer attaches to a send (issue #31). `url` carries the
 * image's data URL out of PromptInput — the app decodes the base64 payload
 * from it to ship bytes over the wire, and the chip preview renders it.
 */
export type AttachedFile = {
  name: string;
  mediaType: string;
  url?: string;
};
/* #420: the engine's `question` ask, as the card shows it (wire shape:
   packages/contracts/src/engine/requests.ts — options carry the id the
   client returns as the answer; `freeText` allows a typed answer besides
   the listed options). */
export type QuestionOption = {
  id: string;
  label: string;
  description?: string;
};
export type QuestionAsk = {
  id: string;
  question: string;
  options?: QuestionOption[];
  freeText?: boolean;
};
export type Reply = {
  from: string;
  time: string;
  /** Model that produced this turn (engine `turn.started.model`). */
  model?: string;
  /** Reasoning effort / fast mode the turn ran with, when the engine reports them. */
  effort?: string;
  fast?: boolean;
  text: string;
  /** #585: the row is a LilOS system note (denied approval, engine end,
      sleep interrupt) — renders as a centred note, never a user/agent
      bubble, and drops when the turn already shows the same status. */
  system?: boolean;
  steps?: Step[];
  streaming?: string;
  /** #106: `options` = the outcome ids the engine offered on the card
      (e.g. ["once","session","always","deny"]) — the buttons follow it;
      absent on old stored asks → the default once/always/deny set. */
  approval?: { id: string; command: string; note: string; options?: string[] };
  /** #420: the turn's open `question` ask — the card under the reply
      collects the answer (option id or free text). */
  question?: QuestionAsk;
  startProposal?: { title: string };
  reasoning?: string;
  thought?: number;
  phase?: Phase;
  live?: boolean;
  /** #419: the engine's `turn.completed.error` on a failed turn — the
      failure chip reads it so "Failed" says *what* failed. */
  error?: string;
  /** #308: the engine opened this leg itself — marked "Agent-initiated"
      instead of reading as an answer to a user message. */
  agentInitiated?: boolean;
  /** Engine request kind the turn waits on (phase === "waiting"), e.g. approval. */
  waitingOn?: "approval" | "question" | "plan";
  id?: string;
  /** Engine turn id on agent-turn cards — stable across the live → relay-row
      id swap, so React keys survive it (a remount would drop user collapse
      state, #320). */
  turnId?: string;
  /** The turn began while this surface's feed was attached (its
      `turn.started` ran past the replay watermark) — vs the turn already
      live when the view mounted (#396); absent on mock/synthesized rows. */
  postAttach?: boolean;
  steers?: string[];
  dur?: number;
  attachments?: AttachedFile[];
  /** Helpers this turn spun off (issue #170), in start order. */
  subagents?: Subagent[];
  /** The plan this turn proposed (issue #175); its steps tick as the work runs. */
  plan?: Plan;
};
/* A plan an employee proposes before touching code (issue #175): Claude Code
   plan mode, Codex plan updates, Hermes todo. Proposed → you approve, ask for
   a change (the next version replaces it) or reject. Once approved its steps
   are the live checklist. */
export type PlanStep = {
  text: string;
  /** Files the step expects to touch. */
  files?: string[];
  status: Todo["status"];
};
export type Plan = {
  id: string;
  /* plan = proposed for your OK first; tasks = the employee's own working
     list (Claude Code TodoWrite, Codex plan, Hermes todo) — never asks,
     starts "approved" and just ticks. Same card either way. */
  kind?: "plan" | "tasks";
  version: number;
  /** One line: what done looks like (tasks lists may have none). */
  goal?: string;
  steps: PlanStep[];
  risks?: string[];
  status: "proposed" | "approved" | "replaced" | "rejected";
};
/* A helper an employee spun off inside one turn (issue #170): its own subagent
   (Hermes delegate_task, Claude Code Task) — steps and result live here — or
   another employee, who works in their own session (D-#25: no group DMs), so
   the row carries only a link to that session, never a copy of its turns. */
export type Subagent = {
  id: string;
  /** Short label: "Map relay reconnect paths". */
  name: string;
  /** The brief the parent handed it. */
  task: string;
  status: "running" | "done" | "failed" | "stopped";
  steps: Step[];
  /** Its final report back to the parent (done / failed). */
  result?: string;
  /** Seconds it ran. */
  dur?: number;
  /** Set when the helper is another employee: their id + the session it opened. */
  employee?: { id: string; session: string };
};
/* A long-running process the agent left running in the session's machine
   (issue #170): dev server, test watcher, build. Hermes terminal(background)
   + process, Claude Code background Bash. `log` is the output tail. */
export type BackgroundJob = {
  id: string;
  command: string;
  status: "running" | "exited" | "failed" | "stopped";
  /** Clock time it started: "10:12". */
  started: string;
  /** How long it has run / ran: "14m". */
  uptime: string;
  /** Local URL when it serves one. */
  url?: string;
  exitCode?: number;
  log: string;
  /** Who started it: a subagent's name when not the employee itself. */
  by?: string;
};
export type Usage = {
  /* Lifetime token throughput (billing-style sums — they outgrow the
     window across turns, so never the meter's numerator; #415). */
  input: number;
  output: number;
  reasoning: number;
  cache: number;
  /* The session's CURRENT context occupancy — the meter's numerator (#415);
     absent when the engine reports no occupancy (fall back to in+out). */
  context?: number;
  /* The context window the engine resolved for this session, reported with
     the turn's usage (issue #294); absent = the meter's labelled estimate. */
  contextWindow?: number;
};
export type CheckRun = {
  name: string;
  status: "pending" | "passed" | "failed" | "skipped";
  /** CI detail link when the forge reports one. */
  url?: string;
};
export type PrComment = {
  from: string;
  time: string;
  text: string;
  monitor?: boolean;
};
/** gh merge methods offered by the PR tab's confirmation (issue #37). */
export type MergeMethod = "squash" | "merge" | "rebase";
/* A pull request an employee opened from its worktree. Read back from the
   forge by the host API (`forge.pr` → `gh pr view`), never by an engine. */
export type PullRequest = {
  number: number;
  repo: string;
  title: string;
  body: string;
  status: "open" | "merged" | "closed";
  /** The forge's URL for the PR — list rows carry it, detail reads may not. */
  url?: string;
  /** An open draft PR reads as its own state, not green "open" (#579). */
  draft?: boolean;
  /** GitHub mergeability when the forge reports it (issue #37). */
  mergeable?: "mergeable" | "conflicting" | "unknown";
  merged?: { by: string; at: string; sha: string };
  author: string;
  base: string;
  head: string;
  opened: string;
  checks: CheckRun[];
  comments: PrComment[];
};
/* A designed failure/notice attached to a session (model error, sleep interrupt, …).
   retry:true means the session can be re-prompted in place. */
export type SessionAlert = {
  kind: "model" | "sleep" | "generic";
  text: string;
  retry?: boolean;
};
/* Whether the session behind a thread holds the machine (#344): `running` while
   a turn or a subagent works, `open` while it sits loaded and idle, `closed`
   once idle-closed (resumes on the next message). */
export type SessionLife = "running" | "open" | "closed";
/* #532: a note on the transcript's state — the kind decides WHERE it
   renders: "trimmed" (#431, the engine's capped log dropped the session's
   head) heads the transcript since it describes history missing above the
   first entry; "unavailable" (#28, the feed can't replay) stays at the
   tail it describes. */
export type TranscriptNote = {
  kind: "trimmed" | "unavailable";
  text: string;
};
export type Thread = {
  session: string;
  /* Engine session state when nothing runs; unset = open. Running is derived
     from the replies (sessionLife), never stored. */
  life?: Exclude<SessionLife, "running">;
  ticket?: string;
  branch?: string;
  /* User-visible session title (renamed by the user; unset = first message is the name). */
  title?: string;
  /* Archived sessions hide from the DM list until the Archived disclosure is opened. */
  archived?: boolean;
  alert?: SessionAlert;
  /* The last turn ended stopped (#583): stamped on the conversation so the
     row's "stopped" word survives a released/replayed session with no live
     turn model. */
  stopped?: boolean;
  /* Running background-job count (#583): the relay-stamped seed for the
     row's "N in background" badge — the live `jobs` list wins once the
     session feed lands. */
  bgJobs?: number;
  /* Set on a session a scheduled task started (#136): the DM marks it and
     the chip opens the task. */
  scheduled?: { task: string; name: string };
  replies: Reply[];
  usage?: Usage;
  todos?: Todo[];
  queue?: string[];
  model?: string;
  /* The rest of the session's pick (model provider, effort, fast) — next turn uses it. */
  provider?: string;
  effort?: string;
  fast?: boolean;
  pr?: PullRequest;
  ws?: Workspace;
  /** Background processes of this session (issue #170), newest last. */
  jobs?: BackgroundJob[];
};
export type Work = {
  ticket: string;
  branch?: string;
  title: string;
  by?: string;
  path?: string;
};

/* Local folders a project owns (Hermes: projects.add_folder / projects.for_cwd). A session's cwd is either the
   folder itself or a worktree inside it: a "workstream" = one branch + one worktree. */
export type Workstream = { branch: string; path: string; from: string };
export type Folder = {
  id: string;
  project: string;
  path: string;
  repo?: string;
  branches: string[];
  workstreams: Workstream[];
  /* The path is gone from disk (#113): shows in recents, can't be picked. */
  missing?: boolean;
}; // branches [] = not a git repo
/* The machine's folders as the gateway sees them (complete.path / projects.for_cwd). Passed IN to AddFolderDialog. */
export type FsDir = {
  git?: { branches: string[]; remote?: string };
  children?: string[];
};

/* Picked in the composer before the first message of a session.
   new = git worktree add -b <branch> <base> · existing = reuse a workstream's worktree · direct = edit the folder checkout on <base>. */
export type WsMode = "new" | "existing" | "direct";
export type WsPick = {
  folder: string | null;
  base: string;
  mode: WsMode;
  existing?: string;
};

/* One row of the `@` menu's Files section (#105): a file or dir inside the
   session's folder, relative to it. The mention sent is the plain `@path`
   text — contents are never inlined (the issue's "Path only" decision). */
export type FileMention = { path: string; kind: "file" | "dir" };
export type Workspace = {
  folder: string;
  project: string;
  label?: string;
  repo?: string;
  mode: WsMode;
  base: string;
  branch: string;
  cwd: string;
  worktree?: string;
};
export type HireDraft = {
  name: string;
  role: string;
  instructions: string;
  /** Engine model id — opaque, may contain `/` (#92 AC-8). */
  model: string;
  /** The model's provider — ids are unique only per provider. */
  provider?: string;
};
/**
 * What the Edit employee dialog hands back on Save (#123). Engine fields are
 * only set when the engine advertises them (`agents` capability
 * `detail.updatable`, D-#19) and the value actually changed — an untouched
 * guarded model must not re-trigger the engine's confirm prompt.
 */
export type EmployeeEditSave = {
  name: string;
  role: string;
  soul?: string;
  model?: string;
  description?: string;
  /** Mirror the display name into the profile (updatable lists "name"). */
  engineName?: boolean;
  /** Re-send after the engine asked to confirm a guarded model. */
  confirmModel?: boolean;
};
/**
 * What an Edit save answers. A `confirmModel` string means the engine held
 * back the model pin and wants a confirm — the dialog shows the message and
 * offers a "Pin anyway" that re-sends with `confirmModel: true`.
 */
export type EmployeeSaveReply = { confirmModel?: string } | undefined;
export type TicketRow = {
  id: string;
  title: string;
  status: string;
  who: string;
  ch: string;
  branch?: string;
};
/**
 * An engine profile as the engine reports it (`agents.list`/`agents.describe`).
 * Engine-agnostic: the id is the profile handle the engine starts sessions
 * with; `name` is its display name when the engine sets one.
 */
export type EngineProfile = {
  id: string;
  name?: string;
  model: string;
  soul: string;
  skills: number;
};

/* Per-profile LilOS connection state (issue #338, agent gateway #336):
   "connected" = the profile's LilOS plugin is enabled; "not-connected" = the
   one-time approval was never given or was declined; "updating" = a connect
   or plugin update is in flight; "failed" = the last attempt failed and
   `reason` carries the plain why. LilOS only enables/disables the plugin —
   it never deletes a profile. */
export type ConnectionState =
  | "connected"
  | "not-connected"
  | "updating"
  | "failed";

/* One profile's connection row — the Connect step and Settings → Engine both
   speak this. */
export type ProfileConnection = {
  /** Engine profile id (`agents.*` handle). */
  profile: string;
  /** Display name of the employee hired on this profile, when there is one. */
  employee?: string;
  state: ConnectionState;
  /** Plain reason shown when state is "failed". */
  reason?: string;
};
export type Msg =
  | {
      kind: "msg";
      id: string;
      from: string;
      time: string;
      text: string;
      thread?: Thread;
      hire?: HireDraft;
      attachments?: AttachedFile[];
    }
  | { kind: "event"; id: string; text: string; ticket: string };

/* A message-level match in the DM session filter (issue #138). Groups under
   its session in the list; `messageId` is the scroll/flash anchor when the
   hit is opened (AC-3). `archived` carries the marker for AC-4. */
export type MessageHit = {
  /** Session's root message id — the `onOpen`/`threadId` key. */
  rootId: string;
  /** The matched message's id. */
  messageId: string;
  from: string;
  time: string;
  /** Excerpt with `<mark>` around matched terms — parsed back into elements,
     never set as HTML. */
  snippet: string;
  archived?: boolean;
};

/* The chain a session needs: relay → harness → engine → model. One line each for the
   status surface; the app builds the rows (and the Copy diagnostics text) from real
   health checks later — this shape is the contract. `blocked` (#53) means the leg is
   down only because an upstream leg is down — neutral, and it does not count as an
   issue. `hint` is the plain next step; `detail` the raw technical line shown collapsed. */
export type ComponentState =
  | "ok"
  | "connecting"
  | "degraded"
  | "blocked"
  | "down";
export type StatusComponent = {
  id: "relay" | "harness" | "engine" | "model";
  label: string;
  state: ComponentState;
  reason: string;
  hint?: string;
  detail?: string;
};

/* Sidebar badge per employee: running turns (blue) / turns waiting on the user (amber). */
export type EmpBadge = { running?: number; approvals?: number };

/* People (non-employee) as display metadata for avatars/names. Passed IN from the app.
   `image` is an optional avatar image URL; without it the avatar falls back to
   the initial on `color` (a Tailwind bg-* class). */
export type Human = {
  name: string;
  color: string;
  guest?: boolean;
  image?: string;
};
/* Lookup used across surfaces: employee by id. */
export type EmpFn = (id: string) => Employee | undefined;
/* Lookup used across surfaces: human (non-employee) by id. */
export type HumanFn = (id: string) => Human | undefined;
/* The signed-in human's author id — surfaces resolve the viewer's display
   name via `human(VIEWER_ID)` so it always reads the live identity (#118). */
export const VIEWER_ID = "user";

/* Theme: light / dark / follow the OS. State lives in the app; ThemeToggle is presentational. */
export type Theme = "light" | "dark" | "system";

/* One selectable model, as the engine reports it via `models.list` (issue #30):
   the picker groups rows by `provider`; `name` is the friendlier label when present.
   `provider` is set only by multi-provider harnesses (Hermes); single-vendor engines
   (Codex, Claude Code) leave it unset — the pick is never a "provider/model" string.
   `efforts` is the engine's ordered (low → high) list for THIS model; absent = no
   reasoning control. When an engine can't say per model, its adapter passes its full
   ladder (Hermes behaviour) — the UI never probes or guesses. `fast` = the model has a
   fast/priority tier (billing is the harness's concern). */
export type ModelOption = {
  id: string;
  name?: string;
  provider?: string;
  efforts?: string[];
  defaultEffort?: string;
  fast?: boolean;
  /* The model's context window, when the engine reports one (issue #294). */
  contextWindow?: number;
  /* Set only by the picker's session-model merge (#140): the session runs a
     model the engine's catalog doesn't list, so the row is synthesized and
     carries the "Not in list" hint — never engine-reported data. */
  notInList?: boolean;
};

/* A provider's display row (multi-provider engines only). `logo` is a
   models.dev slug when the engine knows the vendor (e.g. "anthropic"). */
export type ModelProvider = { id: string; name: string; logo?: string };

/* What the picker reports: model (+ its provider when the engine has several),
   reasoning effort and fast mode. Applies from the next turn. */
export type ModelChoice = {
  model: string;
  provider?: string;
  effort?: string;
  fast?: boolean;
};

/* Models the user hid from the picker — one list for every employee, owned by
   the app (Hermes keeps no such setting). Hidden providers hide their future
   models too; a model new since the last edit is visible by default. */
export type ModelVisibility = { providers: string[]; models: string[] };

/* Optional picker extras; each control renders only when its handler is passed (D-#19). */
export type ModelPickerExtras = {
  providers?: ModelProvider[];
  visibility?: ModelVisibility;
  onVisibility?: (v: ModelVisibility) => void;
  /* Engine caches its catalog (Hermes): re-fetch it. */
  onRefresh?: () => Promise<void>;
};

/* Workbench tab ids (Focus). */
export type WbTab =
  | "changes"
  | "files"
  | "terminal"
  | "preview"
  | "background"
  | "subagents"
  | "plan"
  | "pr";

/* Open-in-editor / Reveal-in-Finder targets (issue #110): the apps os.open
   knows. Editors arrive from os.editors, already in preference order —
   [0] is the default until the settings picker lands (#132). */
export type OsApp = "vscode" | "cursor" | "zed" | "xcode" | "finder";
export type OsEditor = { id: Exclude<OsApp, "finder">; name: string };

/* Settings surface (issue #139; prototyped first, real app in #132). Each
   section renders only when its props are passed (D-#19); all values and
   callbacks are app-owned state. */
export type SettingsSectionId =
  | "general"
  | "approvals"
  | "editors"
  | "models"
  | "engine"
  | "status"
  | "about";
/* Engine approval policy: Smart = routine steps run, risky ones ask;
   Manual = every ask surfaces; Off = never asks. */
export type ApprovalPolicy = "smart" | "manual" | "off";
/* What a brand-new conversation may touch without asking (#106). */
export type ConversationAccess = "ask" | "full";
/* Scheduled tasks (issue #136, prototype #366): a prompt that runs as a new
   session with one employee on a schedule. `time` is "HH:MM" (hourly reads
   only the minutes); `day` 0–6 = Sun–Sat for weekly; `date` "YYYY-MM-DD" for
   once; `cron` five fields for custom. */
export type ScheduleKind =
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "once"
  | "cron";
export type Schedule = {
  kind: ScheduleKind;
  time: string;
  day?: number;
  date?: string;
  cron?: string;
};
/* The latest run of a task. `rootId` is the run's session in the DM. */
export type ScheduledRun = {
  at: string;
  result: "running" | "finished" | "failed";
  rootId?: string;
};
export type ScheduledTask = {
  id: string;
  employee: string;
  name: string;
  prompt: string;
  /** Folder id the run's session opens in; unset = no folder. */
  folder?: string;
  schedule: Schedule;
  /** Access for unattended runs (#106): Ask stops on risky commands. */
  access: ConversationAccess;
  paused?: boolean;
  lastRun?: ScheduledRun;
  /** When a run was skipped because the previous one was still going
      (#136 AC-4); cleared by the next run that starts. */
  skipped?: string;
};
/* An editor found on this Mac (#110) — `path` is the .app bundle. */
export type DetectedEditor = { id: string; name: string; path?: string };
/* A `forge.pr` failure already classified by the host (#114 AC-5) — mirrors
   contracts `ForgeGhReason` (packages/ui doesn't import contracts): "missing"
   = gh isn't installed, "unauthenticated" = run `gh auth login`, "other" =
   anything else. `detail` is the raw stderr — a Details disclosure only,
   never the headline. */
export type PrError = {
  reason: "missing" | "unauthenticated" | "other";
  detail: string;
};

/* ── Ship bar: commit → push → Create PR on the Changes tab (issue #107,
   the accepted #359 design). Presentational: props in, callbacks out; a
   missing handler hides its control (D-#19). */

/** A file row's stage checkbox state, keyed on the diff's `path`. */
export type ShipFile = { path: string; checked: boolean };

/** The typed reasons a ship action reports — drives the bar's plain copy
    (git writes carry GitWriteReason; gh's ForgeGhReason rides along too).
    `detail` is the raw stderr — a Details disclosure only, never the
    headline (same rule as PrError, #114 AC-5). */
export type ShipError = {
  reason?:
    | "rejected"
    | "diverged"
    | "no-remote"
    | "auth"
    | "conflict"
    | "nothing"
    | "exists"
    | "unauthenticated"
    | "missing"
    | "other";
  detail?: string;
  /** Shown when no known reason arrived (or the app wrote the copy itself). */
  text: string;
};

/** Which bar action is in flight — its button reads busy. */
export type ShipBusy = "commit" | "push" | "pull" | "pr" | "suggest" | null;

/** The bar's state — app-owned; async work writes back through the
    handlers, never by mutating this. */
export type ShipBar = {
  /** The folder is a git work tree — false renders nothing (AC-6). */
  isRepo: boolean;
  /** Working branch; null = detached HEAD. */
  branch: string | null;
  /** The remote's default branch (`origin/HEAD` short name): on it, Create
      PR asks for a new branch name first (AC-4). */
  defaultBranch?: string | null;
  /** `origin` URL when configured — copy detail for the no-remote error. */
  remote?: string | null;
  /** Every diff row's stage state (all checked by default). */
  files: ShipFile[];
  /** Commits on the branch — PR title/body prefill. */
  commits: GitCommit[];
  /** Commit message draft (app-owned: Suggest's answer writes back through
      `onMessage`; persisted as a `lilos:` draft by the app so it survives
      a reload — #584). */
  message: string;
  /** In-flight action — its button reads busy + the rest disables. */
  busy: ShipBusy;
  /** The last action's failure — cleared by the next one. */
  error: ShipError | null;
  /** A turn is running — the bar stays usable; Suggest keeps working
      because it is a side ask, not a steer (#584). */
  running: boolean;
  /** Upstream after a successful push (`origin/<branch>`) — the bar's ↑
      chip; muted while a push error is on screen (issue #393 AC-6). */
  upstream?: string | null;
  /** Optional chrome slot (the prototype's error-state switch lands here). */
  accessory?: ReactNode;
  /** The employee's name — error copy names it as the next step's owner
      ("Ask Default to publish it") so no error asks for a terminal
      command (#579). */
  employeeName?: string;
};

/** ShipBar callbacks — async ones are awaited; a rejection surfaces as the
    bar's error, so the app throws `{ reason?, detail? }`-shaped errors. */
export type ShipHandlers = {
  onMessage?: (message: string) => void;
  /** Ask the engine for a one-line commit message — a side request that
      touches neither transcript nor session context (#584). Resolves with
      the suggested message; the bar writes it into `message` through
      `onMessage`. */
  onSuggest?: () => Promise<string | void> | string | void;
  /** Stage `files` (the checked set) + commit them with `message`. */
  onCommit?: (files: string[], message: string) => Promise<void>;
  /** Push the branch — sets upstream on the first push. */
  onPush?: () => Promise<void>;
  /** `git pull --ff-only` — the fix the rejected-push copy names (issue
      #393 AC-5); a diverged history rejects with reason 'diverged'. */
  onPull?: () => Promise<void>;
  /** Posts a user message asking the agent to update the branch — offered
      on a rejected/diverged state (issue #393 AC-5). */
  onAskAgent?: () => void;
  /** Create the PR; on the default branch `branch` is the new branch's name. */
  onCreatePr?: (pr: {
    title: string;
    body: string;
    branch?: string;
  }) => Promise<void>;
};

/* Live host accessors for a session's real cwd (fs/git issue #11, forge #37).
   An accessor resolves null when the host is unreachable → the caller falls
   back to mock data; `forge.pr` resolving `{ pr: null }` is the host's real
   answer "this checkout has no PR" (controls render only when handlers exist,
   D-#19). */
export type HostAccessors = {
  tree: (cwd: string) => Promise<string[] | null>;
  diff: (cwd: string) => Promise<Diff[] | null>;
  read: (
    cwd: string,
    path: string,
  ) => Promise<{
    content: string;
    binary: boolean;
    truncated: boolean;
  } | null>;
  /* `forge.pr` resolves the checkout's branch PR. `{ pr: null }` = real
     checkout with no PR on the branch; `{ pr: null, error }` = the forge call
     itself failed (gh missing/unauthenticated — shown plainly in the tab,
     issue #114 AC-5); outer null = the method didn't answer → tab hidden. */
  pr?: (cwd: string) => Promise<{
    pr: PullRequest | null;
    /** The checkout branch the forge probed — labels the "no PR" state. */
    branch?: string;
    error?: PrError;
  } | null>;
  /** Posts a comment via `gh`; resolves the comment URL; throws on failure. */
  prComment?: (cwd: string, body: string) => Promise<string>;
  /** Merges via `gh`; resolves the re-read PR; throws on failure. */
  prMerge?: (cwd: string, method: MergeMethod) => Promise<PullRequest>;
  /** os.editors (issue #110): editors detected on the session machine, in
     preference order; [] when none. */
  osEditors?: () => Promise<OsEditor[]>;
  /** os.open (issue #110): open `path` (or cwd itself) in an editor, at `line`
     when the editor takes one, or reveal it in Finder; throws on failure. */
  osOpen?: (
    cwd: string,
    path: string,
    app: OsApp,
    line?: number,
  ) => Promise<void>;
  /** host.describe's implemented-method set (issue #107): a bar control
      renders only when its host method is in it (D-#19, AC-6). The app
      may cache the answer. */
  methods?: () => Promise<Set<string>>;
  /** git.status — the checkout's branch + changed paths; null when the
      folder is no repo (the ship bar keys isRepo off this). */
  status?: (cwd: string) => Promise<{
    branch: string | null;
    clean: boolean;
    files: { path: string; status: string; origPath?: string }[];
  } | null>;
  /** git.branches — locals + current + `origin` URL + the remote's default
      branch (Create PR's on-the-default ask keys off `default`). */
  branches?: (cwd: string) => Promise<{
    current: string | null;
    branches: string[];
    remote: string | null;
    default: string | null;
  } | null>;
  /** git.log — commits on the branch vs its resolved base; feeds the
      Commits section + the Create-PR prefill. */
  log?: (cwd: string) => Promise<GitCommit[] | null>;
  /** git.commit — stage + commit the listed paths; throws on failure. */
  commit?: (cwd: string, files: string[], message: string) => Promise<void>;
  /** git.push — `-u origin <branch>` the first time; resolves the
      upstream it pushed to, throws on failure. */
  push?: (cwd: string) => Promise<{ upstream: string | null }>;
  /** git.pull — `git pull --ff-only`; throws on a diverged history. */
  pull?: (cwd: string) => Promise<void>;
  /** git.createBranch — `checkout -b`; throws on an invalid/existing name. */
  createBranch?: (cwd: string, name: string) => Promise<void>;
  /** forge.create — `gh pr create`; resolves the PR's URL, throws on
      failure ({reason,detail}-shaped like prComment/prMerge). */
  prCreate?: (
    cwd: string,
    pr: { title: string; body: string; base?: string },
  ) => Promise<string>;
};

/* A `workbench_open` target as the Workbench's spot request (issue #340):
   the agent's "look at this" — a file (optionally at a line), the changes
   view (optionally one file), the PR tab, a URL for the preview tab, or an
   engine tab (#543 — the only kind a folderless session accepts).
   Structural mirror of `WorkbenchOpenTarget` in contracts (ui keeps no
   contracts dep) — a flat object: exactly one of file/diff/pr/url/tab set.
   `at` makes a repeated open of the same target re-fire. */
export type WbSpot = {
  at: number;
  target: {
    file?: string;
    line?: number;
    diff?: true;
    path?: string;
    pr?: true;
    url?: string;
    tab?: "subagents" | "background" | "plan";
  };
};
