import type { OrbState, OrbTone } from "../components/orb";

/* View models for the employee screens — shaped for display, not a wire
   contract (the relay's real types land in packages/contracts later). */

export type EmployeeRow = {
  id: string;
  name: string;
  role: string;
  tone: OrbTone;
  state: OrbState;
  /** What they're doing now, e.g. "Sorting inbox" or "Waiting on you · ac-80 flake". */
  now: string;
  /** #591: the row shows a state the Mac could no longer update (offline)
      — the live tint dims (muted line, no working dots, no orb ring) and
      `now` starts "Last known · …" so the marker survives truncation. */
  lastKnown?: boolean;
  /** Ticket key shown before `now`, e.g. "LIL-7". */
  ticket?: string;
  /** Right-hand time: "now", "6m", "10:12". */
  when: string;
};

export type ChannelRow = {
  id: string;
  name: string;
  unread?: number;
  /** Someone working in it right now (shows their orb + dots). */
  activeTone?: OrbTone;
};

export type ProjectGroup = {
  id: string;
  name: string;
  /** Short key, e.g. "LIL". */
  key: string;
  channels: ChannelRow[];
};

/* #420: a question option as the wire carries it — `id` is what the client
   returns as the answer (contracts: QuestionOption). */
export type QuestionOption = {
  id: string;
  label: string;
  description?: string;
};

/** #601: the grant choices an approval ask can offer — the wire's
    ApprovalOption ("This thread" in UI copy is `session`). */
export type GrantOption = "once" | "session" | "always" | "deny";

/** Something an employee is blocked on until you choose. */
export type Approval = {
  id: string;
  employeeId: string;
  employee: string;
  tone: OrbTone;
  session: string;
  /** The wire ask's kind; a question can't be approved (it needs an answer,
      not an OK) so surfaces hide its Approve pill. Absent = approval
      (prototype rows). */
  kind?: "approval" | "plan" | "question";
  /** #595: the primary pill a surface may show — "review" for plans (the
      pill opens the plan's thread; a plan is never approved unseen),
      "approve" for command approvals; questions have none. Absent =
      "approve" (prototype rows). */
  primary?: "approve" | "review";
  /** Why, in one sentence — on a question ask this IS the question. */
  reason: string;
  /** A shell command it wants to run… */
  command?: string;
  /** …or a file it wants to post. */
  file?: { name: string; detail: string };
  /** #601: the options an approval ask itself offers (wire
      `request.options`), in display order — Once / This session / Always /
      Deny. Absent on questions, plans and prototype rows; an approval row
      without it falls back to Once + Deny. Distinct from `options`, which
      is a question's answer buttons. */
  grantOptions?: GrantOption[];
  /** #420: question options as buttons (id → the answer sent back). */
  options?: QuestionOption[];
  /** #420: the ask allows a typed answer besides the listed options. */
  freeText?: boolean;
  /** "2m" */
  age: string;
  /** #591: this row is last-known (the Mac is unreachable) — surfaces say
      so and never offer a dead Approve/Deny. */
  lastKnown?: boolean;
};

export type SessionState =
  | "done"
  | "needs-you"
  | "working"
  | "failed"
  | "stopped";

/** #592: the last turn's failure — the wire's `Conversation.turnFailure`.
    `sleep` interrupts read amber ("Mac went to sleep"); `model`/`generic`
    errors read red. */
export type TurnFailure = {
  kind: "model" | "sleep" | "generic";
  text: string;
};

/** #344 (web: SessionLife): whether the engine session holds the Mac. */
export type SessionLife = "running" | "open" | "closed";

/** One DM row: your message and the session it opened, summarised. */
/** A pull request a session opened (web: PullRequest, trimmed to what the
    phone shows). A session can open several; newest last. */
export type PullRequestRef = {
  number: number;
  title: string;
  status: "draft" | "open" | "merged" | "closed";
  /** CI on an open PR. */
  checks?: "pending" | "passing" | "failing";
  /** #598: the PR's URL — every row/badge/card taps through to it. */
  url?: string;
};

export type SessionTurn = {
  id: string;
  prompt: string;
  title: string;
  state: SessionState;
  when: string;
  /** Project the session runs in ("LilOS"); absent = just chat. */
  folder?: string;
  branch?: string;
  added?: number;
  removed?: number;
  replies?: number;
  /** #344: the engine session behind this thread — running (a turn or any
      subagent), open (loaded, idle), closed (idle-closed; reopens on the
      next message). Drives the ring round the replies count. */
  life?: SessionLife;
  /** The employee's latest words, shown as the card's body. */
  preview?: string;
  /** What it's doing right now (working sessions). */
  live?: string;
  steps?: number;
  model?: string;
  approval?: Approval;
  prs?: PullRequestRef[];
  /** #592: set when the last turn failed — the row's body is the reason,
      not the preview. */
  failure?: TurnFailure;
};

/** A helper a turn spun off (web: Subagent): its own subagent, with its
    steps + report, or another employee working in their own session —
    then only a link to that thread. */
export type SubagentRow = {
  id: string;
  name: string;
  /** The brief the parent handed it. */
  task: string;
  status: "running" | "done" | "failed" | "stopped";
  steps: ToolStep[];
  result?: string;
  /** Seconds it ran. */
  dur?: number;
  employee?: { id: string; name: string; tone: OrbTone; threadId?: string };
};

/** A plan an employee proposes before editing (web: Plan). Approved, its
    steps are the live checklist; replaced = a newer version took over. */
export type PlanRow = {
  id: string;
  /** tasks = the employee's own working list: no OK asked, it just ticks. */
  kind?: "plan" | "tasks";
  version: number;
  goal?: string;
  steps: {
    text: string;
    files?: string[];
    status: "pending" | "in_progress" | "completed" | "cancelled";
  }[];
  risks?: string[];
  status: "proposed" | "approved" | "replaced" | "rejected";
};

/** Tokens in a session's context window. */
export type ContextUsage = {
  /* Lifetime token throughput — never the meter's numerator: the sums
     outgrow the window across turns (#415). */
  input: number;
  output: number;
  reasoning: number;
  cache: number;
  /** The session's CURRENT occupancy — the numerator when the engine
      reports it (#415); absent = the in+out fallback. */
  context?: number;
  /** The window the meter divides by — engine-reported when it carries one,
      else the labelled estimate `contextWindowOf` returns (#294). */
  max: number;
  /** True when `max` is an estimate (the engine reported no window) — the
      meter labels it `~` like the web (#294). */
  estimated?: boolean;
};

/** A process left running for the session (web: BackgroundJob). */
export type BackgroundJobRow = {
  id: string;
  command: string;
  status: "running" | "exited" | "failed" | "stopped";
  started: string;
  uptime: string;
  url?: string;
  exitCode?: number;
  /** Output tail. */
  log: string;
  by?: string;
  /** The row IS a subagent (#309) — no Stop: jobs.stop can't kill one. */
  subagent?: boolean;
};

/** One tool call inside an agent turn (web: Step). */
export type ToolStep = {
  id: string;
  /** Engine tool id: terminal, read_file, write_file, patch, search_files, web_search… */
  tool: string;
  /** The one argument worth showing: a path, a command, a query. */
  arg?: string;
  output?: string;
  running?: boolean;
  add?: number;
  del?: number;
  /** Unified diff of an edit (web: Diff.patch) — shown when the step opens. */
  patch?: string;
};

export type AgentEntry = {
  kind: "agent";
  id: string;
  time: string;
  reasoning?: string;
  /** Seconds spent thinking. */
  thought?: number;
  /** Reasoning is streaming right now — live + the turn is in its
     thinking phase (web: `live && phase === "thinking"`). Drives the
     expanded "Thinking…" row; distinct from `live` so a turn already
     past reasoning collapses to "Thought for Ns" while it keeps
     working. */
  thinking?: boolean;
  steps?: ToolStep[];
  text?: string;
  /** Still running: reasoning shimmers, the last step is live. */
  live?: boolean;
  /** The turn is blocked on an open ask — its kind ("approval" needs a
     decision on a command, "plan" a plan review, "question" an answer).
     Surfaces read "Waiting…", never Running/Thinking (#264). */
  waiting?: "approval" | "plan" | "question";
  /** You pressed Stop mid-turn. */
  stopped?: boolean;
  /** #419: the turn ended on an engine error — the failure row reads it
      (web: the turn's "Failed · <error>" chip). */
  failed?: string;
  /** #308: the engine opened this leg itself — "Agent-initiated" chip
      instead of reading as an answer to a user message. */
  agentInitiated?: boolean;
  /** The reply is streaming (steps are over for now). */
  writing?: boolean;
  /** What you decided on this turn's approval — kept as a receipt.
      `question` (#420) marks an answered/cancelled question ask: the
      receipt reads "You answered:" / "You cancelled:". */
  decided?: {
    approved: boolean;
    what: string;
    question?: boolean;
    /** #601: the wire outcome granted — the receipt names it ("This
        session", "always", …) instead of a bare "approved". */
    outcome?: string;
  };
  approval?: Approval;
  /** The plan this turn proposed (issue #175; web: Plan). */
  plan?: PlanRow;
  /** Helpers this turn spun off (issue #170; web: Subagent). */
  subagents?: SubagentRow[];
  /** The PR this turn opened — card under the reply (#159; web: PrCard). */
  pr?: PullRequestRef;
  /** Worked for 21s · Opus 5.5 · High · 5 steps · 2 files changed */
  footer?: { dur?: number; model?: string; effort?: string; files?: number };
};

/** What a `workbench_open` call asks the app to show (#340) — the desktop
    opens its Workbench on the matching tab; the phone gets this tappable
    card in the thread instead (structural mirror of the wire target: a
    flat object with exactly one of file/diff/pr/url/tab set; `tab` names an
    engine tab — #543, the only kind a folderless session accepts). */
export type WbCardTarget = {
  file?: string;
  line?: number;
  diff?: true;
  path?: string;
  pr?: true;
  url?: string;
  tab?: "subagents" | "background" | "plan";
};

/** A `workbench.opened` event as a thread row: the agent's "look at this"
    lands as a card that opens the same thing the desktop's Workbench
    would show (#340 AC-2b). */
export type WbCardEntry = {
  kind: "workbench";
  id: string;
  time: string;
  target: WbCardTarget;
};

export type ThreadEntry =
  | {
      kind: "user";
      id: string;
      time: string;
      text: string;
      /** Sent while the employee was mid-turn; runs when it finishes. */
      queued?: boolean;
      /** Queued behind a conversation that is blocked on an open ask — the
         caption reads "Waiting for you", not "Queued · runs next" (#264). */
      waiting?: boolean;
    }
  | AgentEntry
  | WbCardEntry;

/** A session opened as a thread (web: ThreadView). */
export type ThreadDetail = {
  id: string;
  title: string;
  state: SessionState;
  /** #592: the last turn's failure — the header chip reads amber
      "Mac went to sleep" for sleep interrupts. */
  failure?: TurnFailure;
  /** #308: the running turn is engine-initiated (a leg) — the composer
      offers "Queue" instead of "Steer" (web: runningComposer agentWork). */
  agentWorking?: boolean;
  employee: { id: string; name: string; tone: OrbTone };
  /** DM list time: "Mon", "Yesterday", "4m", "now". */
  when: string;
  /** Thread info: "Yesterday 17:02". */
  started: string;
  /** "LilOS" + "~/Desktop/Oscar/LilOS"; absent = just chat. */
  folder?: { name: string; path: string };
  /** feat/relay-reconnect, off main in .lilos/wt/lil-9 */
  branch?: { name: string; detail: string };
  model: string;
  session: string;
  usage?: string;
  /** PRs this session opened, oldest first. */
  prs?: PullRequestRef[];
  /** Token breakdown of the context window (web: Usage + window size). */
  context?: ContextUsage;
  /** Background processes of this session, newest last. */
  jobs?: BackgroundJobRow[];
  /** #514: a note on the transcript's state (web: transcriptNote). Notes
     about missing HEAD history render as the first scroll item — a
     centered divider before the entries; e.g. "Earlier history was
     trimmed" when the engine's capped log dropped this session's
     head (#431). */
  transcriptNote?: string;
  entries: ThreadEntry[];
};

/* ── Pickers (web: WorkspacePicker + ModelPicker) ─────────────────────────── */

export type FolderOption = {
  id: string;
  project: string;
  path: string;
  /** The git probe is still in flight — mode rows wait on it. */
  probing?: boolean;
  /** The path is gone from the Mac — picking it can't open a session. */
  missing?: boolean;
  /** [] = not a git repo (or probe unanswered): edits land in the folder directly. */
  branches: string[];
  workstreams: { branch: string; path: string; from?: string }[];
};

/** new = worktree + branch off `base` · existing = continue a workstream · direct = edit `base` in place. */
export type WorkspacePick = {
  folder: string | null;
  base: string;
  mode: "new" | "existing" | "direct";
  existing?: string;
};

export type ModelRow = {
  id: string;
  name: string;
  provider: string;
  efforts?: string[];
  defaultEffort?: string;
  fast?: boolean;
  /** The model's context window, when the engine reports one (web
      `ModelOption.contextWindow`, #294). */
  contextWindow?: number;
  /** The session runs a model the catalog omits (web `notInList`): the row
      carries the hint instead of offering a pick the engine can't honour. */
  notInList?: boolean;
};

export type ModelPick = {
  model: string;
  /** Model ids are unique only per provider on multi-provider engines —
      the pick pins the provider when it knows one (web ModelChoice). */
  provider?: string;
  effort?: string;
  fast?: boolean;
};

/** The shared "Edit models" hide list (web `ModelVisibility`): provider
    ids plus `${provider}::${id}` model keys — relay-persisted, one list
    for the whole company. */
export type ModelVisibility = { providers: string[]; models: string[] };

/** An engine's model provider; `logo` = models.dev slug (web: ModelProvider). */
export type ModelProviderRow = { id: string; name: string; logo?: string };

/** One folder level on the paired Mac, as the relay lists it (web: FsDir). */
export type MacDir = {
  /** Current branch when this folder is a git repo. */
  branch?: string;
  folders: { name: string; path: string; branch?: string }[];
};
