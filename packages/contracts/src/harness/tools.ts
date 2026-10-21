import { z } from "zod";
import {
  AppMessage,
  ConversationState,
  EmployeeStatus,
  WorkbenchOpenTarget,
} from "../app/domain.js";
import { Project } from "../app/project.js";
import { ScheduledTask, TaskSchedule } from "../app/schedule.js";
import {
  Goal as GoalSchema,
  TicketResult as TicketResultSchema,
  Ticket as TicketSchema,
  TicketStatus,
  TicketStep,
  TicketWaitingOn,
} from "../app/ticket.js";
import { MessageSearchHit, StatusComponent } from "../app/wire.js";
import { ConversationAccess } from "../engine/approvals.js";
import { ForgePrListItem } from "../host/forge.js";

/**
 * The one LilOS tool catalog (D-#36, #337): every operation an engine
 * session can call through the Agent Gateway — the MCP streamable-HTTP
 * endpoint, the `lilos mcp` stdio server, and the `lilos` CLI all render from
 * this table, and so do the host policy and the `lilos_guide` pages that
 * state tool facts: the gateway page lists every area
 * (`packages/surfaces/src/guide/gateway.ts`, #754); the approvals and
 * employees pages list every `access: "approval"` tool
 * (`packages/surfaces/src/guide/approval-tools.ts`, #783).
 *
 * Names are canonical `<area>_<action>` ("root" tools like `context`/`guide`
 * carry no prefix). Each entry declares its `area`, its `access` level
 * (`read` is always allowed, `write` mutates the session's own surfaces,
 * `approval` asks the user first), a doc line, and Zod params/result
 * contracts.
 *
 * Scope is ambient, not an argument: the gateway binds each caller to one
 * session via its per-session bearer (or `x-lilos-session`), so an agent can
 * never address another session's browser/terminal/thread. The engine's own
 * session id is only an alias for that scope, never an argument.
 *
 * Per-engine adapters (an in-process engine plugin today; later runtimes
 * through ACP `mcpServers` at `session/new`, #111) only attach this catalog —
 * they never grow a tool list of their own. Not: attaching MCP only through ACP, or
 * engine-specific UI toolsets (`desktop_ui` / `drive_preview` /
 * `read_terminal`, the first #36 design).
 */

/** Tool areas — `tools/list`, the host policy and the gateway guide page
 * speak in these. */
export const TOOL_AREAS = [
  "root",
  "thread",
  "team",
  "folder",
  "project",
  "ticket",
  "goal",
  "workbench",
  "browser",
  "terminal",
  "schedule",
] as const;
export type ToolArea = (typeof TOOL_AREAS)[number];

/** `read` never mutates; `write` mutates this session's own surfaces;
 *  `approval` changes the company — always asks the user first (the gate
 *  lives in apps/harness/src/harness/gateway-ops.ts). */
export const TOOL_ACCESS = ["read", "write", "approval"] as const;
export type ToolAccess = (typeof TOOL_ACCESS)[number];

/* --------------------------------- browser -------------------------------- */

export const BrowserOpenParams = z.strictObject({
  url: z.string().min(1),
});
export type BrowserOpenParams = z.infer<typeof BrowserOpenParams>;
export const BrowserOpenResult = z.object({
  url: z.string(),
  title: z.string(),
});
export type BrowserOpenResult = z.infer<typeof BrowserOpenResult>;

export const BrowserClickParams = z.strictObject({
  /** CSS selector; Playwright semantics (text=…, role queries work). */
  selector: z.string().min(1),
});
export type BrowserClickParams = z.infer<typeof BrowserClickParams>;
export const BrowserClickResult = z.object({
  ok: z.literal(true),
});
export type BrowserClickResult = z.infer<typeof BrowserClickResult>;

export const BrowserTypeParams = z.strictObject({
  /** Focused element when omitted; otherwise the field to fill. */
  selector: z.string().min(1).optional(),
  text: z.string(),
});
export type BrowserTypeParams = z.infer<typeof BrowserTypeParams>;
export const BrowserTypeResult = z.object({ ok: z.literal(true) });
export type BrowserTypeResult = z.infer<typeof BrowserTypeResult>;

export const BrowserReadParams = z.strictObject({});
export type BrowserReadParams = z.infer<typeof BrowserReadParams>;
export const BrowserReadResult = z.object({
  url: z.string(),
  title: z.string(),
  /** Visible page text, whitespace-collapsed and capped by the backend. */
  text: z.string(),
});
export type BrowserReadResult = z.infer<typeof BrowserReadResult>;

export const BrowserScrollParams = z.strictObject({
  /** Page-space pixel delta; negative scrolls up. */
  dy: z.number(),
});
export type BrowserScrollParams = z.infer<typeof BrowserScrollParams>;
export const BrowserScrollResult = z.object({ ok: z.literal(true) });
export type BrowserScrollResult = z.infer<typeof BrowserScrollResult>;

export const BrowserEvalParams = z.strictObject({
  /** JavaScript evaluated in the page; returns the JSON-serializable value. */
  expression: z.string().min(1),
});
export type BrowserEvalParams = z.infer<typeof BrowserEvalParams>;
export const BrowserEvalResult = z.object({
  value: z.unknown().optional(),
});
export type BrowserEvalResult = z.infer<typeof BrowserEvalResult>;

/* --------------------------------- terminal ------------------------------- */

export const TerminalRunParams = z.strictObject({
  command: z.string().min(1),
  /** Backend default applies when omitted (bounded). */
  timeoutMs: z.int().min(1).optional(),
});
export type TerminalRunParams = z.infer<typeof TerminalRunParams>;
export const TerminalRunResult = z.object({
  output: z.string(),
  exitCode: z.int(),
});
export type TerminalRunResult = z.infer<typeof TerminalRunResult>;

/** Raw keystrokes for interactive programs (servers, REPLs). */
export const TerminalWriteParams = z.strictObject({
  data: z.string(),
});
export type TerminalWriteParams = z.infer<typeof TerminalWriteParams>;
export const TerminalWriteResult = z.object({ ok: z.literal(true) });
export type TerminalWriteResult = z.infer<typeof TerminalWriteResult>;

export const TerminalReadParams = z.strictObject({
  /** Tail bytes of the PTY scrollback; backend default applies when omitted. */
  tailBytes: z.int().min(1).optional(),
});
export type TerminalReadParams = z.infer<typeof TerminalReadParams>;
export const TerminalReadResult = z.object({
  output: z.string(),
});
export type TerminalReadResult = z.infer<typeof TerminalReadResult>;

/* --------------------------------- workbench ------------------------------ */

export const PreviewTarget = z.object({
  url: z.string(),
  /** "scan" = PTY output URL match; "marker" = explicit `PREVIEW: <url>` line. */
  via: z.enum(["scan", "marker"]),
});
export type PreviewTarget = z.infer<typeof PreviewTarget>;

export const WorkbenchPreviewsParams = z.strictObject({});
export type WorkbenchPreviewsParams = z.infer<typeof WorkbenchPreviewsParams>;
export const WorkbenchPreviewsResult = z.object({
  previews: z.array(PreviewTarget),
});
export type WorkbenchPreviewsResult = z.infer<typeof WorkbenchPreviewsResult>;

/* `workbench_open`'s params ARE the app-domain `WorkbenchOpenTarget` — the
   gateway forwards it verbatim into `workbench.open` / `workbench.opened`
   (declared there, not duplicated here). Keep every tool's params a
   TOP-LEVEL OBJECT schema: `z.toJSONSchema` on unions/anyOf emits no
   `type:"object"`/`properties`, so function-calling clients would advertise
   the tool with no arguments (#340 live-leg regression test pins this). */
export const WorkbenchOpenResult = z.object({
  opened: z.literal(true),
});
export type WorkbenchOpenResult = z.infer<typeof WorkbenchOpenResult>;

/* ---------------------------------- root ---------------------------------- */

/** `context` — the "who am I and where am I" answer (#340). */
export const ContextParams = z.strictObject({});
export type ContextParams = z.infer<typeof ContextParams>;
export const ContextResult = z.object({
  /** The employee this session is bound to. */
  employee: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    role: z.string(),
    /** Engine profile the employee runs on. */
    profile: z.string(),
    model: z.string(),
  }),
  /** The employee's channel — the internal routing scope, not a place. */
  channel: z.object({
    id: z.string().min(1),
    kind: z.string(),
  }),
  /** This session's thread in that channel. */
  thread: z.object({
    id: z.string().min(1),
    title: z.string(),
    state: ConversationState,
    /** The pinned model when the conversation carries one. */
    model: z.string().optional(),
    /** The thread's access level (#106) — `ask` = risky actions raise an
        approval card to the user; `full` = the harness auto-approves. */
    access: ConversationAccess,
  }),
  /** The session's working folder; `branch` when it is a workstream. */
  folder: z
    .object({
      path: z.string(),
      branch: z.string().optional(),
      repoPath: z.string().optional(),
    })
    .optional(),
  /** The signed-in human (profile.get). */
  user: z.object({ name: z.string().optional() }),
  /** The Mac's health per system.status. */
  mac: z.object({
    /** Worst component state rolled up: ok / degraded / down. */
    state: z.enum(["ok", "degraded", "down"]),
    components: z.array(StatusComponent),
  }),
  /**
   * This session's context fullness (#559) — the same numbers Oscar's
   * context meter shows: `used` is the meter's numerator (the engine's
   * current-occupancy report when it sends one, else the lifetime
   * in+out sum — `contextUsedOf`, #415); `window` is the engine-reported
   * window (absent when the engine reports none). Absent until a turn
   * completes — `Conversation.usage` rides the relay row (#300).
   */
  usage: z
    .object({
      used: z.int().min(0),
      window: z.int().positive().optional(),
    })
    .optional(),
  /** Tool areas attached to this session. */
  areas: z.array(z.string()),
  /** Host-policy version this session was issued under. */
  hostPolicyVersion: z.int(),
});
export type ContextResult = z.infer<typeof ContextResult>;

/** `guide` — the LilOS docs shipped with the app (#340 AC-3). */
export const GUIDE_TOPICS = [
  "overview",
  "threads",
  "employees",
  "approvals",
  "workbench",
  "mobile",
  "gateway",
] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];
export const GuideParams = z.strictObject({
  /** One of GUIDE_TOPICS; omitted returns the topic index. */
  topic: z.enum(GUIDE_TOPICS).optional(),
});
export type GuideParams = z.infer<typeof GuideParams>;
export const GuideResult = z.object({
  /** The topic served, or "index" when none was asked for. */
  topic: z.string(),
  title: z.string(),
  body: z.string(),
});
export type GuideResult = z.infer<typeof GuideResult>;

/**
 * `ask` (D-#773) — wait on the user. `why`, `ifYes` and `ifNo` are the
 * Needs you lines. `options` makes it a question; without them it is an
 * approval (once/deny). An engine approval keeps its command and does
 * not use these fields.
 */
export const AskParams = z.strictObject({
  question: z.string().min(1),
  why: z.string().min(1).optional(),
  ifYes: z.string().min(1).optional(),
  ifNo: z.string().min(1).optional(),
  options: z.array(z.string().min(1)).min(1).optional(),
});
export type AskParams = z.infer<typeof AskParams>;
export const AskToolResult = z.object({
  /** The user agreed. A denial throws `declined` and never returns `"no"`. */
  outcome: z.literal("yes"),
  /** The chosen option's label, when the ask was a question. */
  answer: z.string().min(1).optional(),
});
export type AskToolResult = z.infer<typeof AskToolResult>;

/* ---------------------------------- team ---------------------------------- */

export const TeamListParams = z.strictObject({});
export type TeamListParams = z.infer<typeof TeamListParams>;
export const TeamListResult = z.object({
  employees: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      role: z.string(),
      status: EmployeeStatus,
      model: z.string(),
      /** Set when they report to an employee; absent means the owner (D-#775). */
      reportsTo: z.string().min(1).optional(),
    }),
  ),
});
export type TeamListResult = z.infer<typeof TeamListResult>;

/**
 * `team_hire` — propose a hire; the ask card carries the draft and
 * nothing is written until the user approves. `profile` names an existing
 * engine profile to reuse — omitted, the apply creates one from the draft
 * (`agents.create`) the way the hire dialog does. Hiring stays open to
 * every agent, including a company with no CEO yet, and always asks the
 * owner (D-#341).
 */
export const TeamHireParams = z.strictObject({
  name: z.string().min(1),
  role: z.string().min(1),
  model: z.string().min(1),
  instructions: z.string().min(1),
  profile: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
});
export type TeamHireParams = z.infer<typeof TeamHireParams>;
export const TeamHireResult = z.object({
  employee: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    role: z.string(),
    profile: z.string(),
    model: z.string(),
  }),
});
export type TeamHireResult = z.infer<typeof TeamHireResult>;

/**
 * `team_set_ceo` — propose giving the CEO position to an employee (D-#778).
 * The ask waits; `company.setCeo` runs only after the user approves.
 * The caller's session must be the current holder's. With no CEO, this
 * tool is offered to nobody — the owner appoints the first holder in the
 * app (D-#778).
 */
export const TeamSetCeoParams = z.strictObject({
  employeeId: z.string().min(1),
});
export type TeamSetCeoParams = z.infer<typeof TeamSetCeoParams>;
export const TeamSetCeoResult = z.object({
  ceoId: z.string().min(1),
});
export type TeamSetCeoResult = z.infer<typeof TeamSetCeoResult>;

/**
 * `team_update` — edit the calling employee's own record (name, role,
 * model, instructions, who they report to). The employee id comes from
 * the session binding, never from a param: an agent cannot edit a
 * colleague. `reportsTo: null` reports to the owner again (D-#775).
 */
export const TeamUpdateParams = z
  .strictObject({
    name: z.string().min(1).optional(),
    role: z.string().optional(),
    model: z.string().optional(),
    instructions: z.string().optional(),
    reportsTo: z.string().min(1).nullable().optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), {
    message: "at least one field to change",
  });
export type TeamUpdateParams = z.infer<typeof TeamUpdateParams>;
export const TeamUpdateResult = z.object({
  employee: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    role: z.string(),
    model: z.string(),
    instructions: z.string(),
    /** Set when they report to an employee; absent means the owner (D-#775). */
    reportsTo: z.string().min(1).optional(),
  }),
});
export type TeamUpdateResult = z.infer<typeof TeamUpdateResult>;

/* ---------------------------------- folder -------------------------------- */

/** `folder_add` — propose binding a repo folder the user can pick. */
export const FolderAddParams = z.strictObject({
  path: z.string().min(1),
});
export type FolderAddParams = z.infer<typeof FolderAddParams>;
export const FolderAddResult = z.object({
  folder: z.object({
    path: z.string(),
    lastUsedAt: z.number(),
  }),
});
export type FolderAddResult = z.infer<typeof FolderAddResult>;

/* ---------------------------------- thread -------------------------------- */

/**
 * The session's own thread: the gateway binds the conversation from the
 * session record — the agent can never address another thread. LilOS never
 * stores transcripts.
 */
export const ThreadPostParams = z.strictObject({
  text: z.string().min(1),
});
export type ThreadPostParams = z.infer<typeof ThreadPostParams>;
export const ThreadPostResult = z.object({
  message: AppMessage,
});
export type ThreadPostResult = z.infer<typeof ThreadPostResult>;

export const ThreadReadParams = z.strictObject({
  /** Which of your threads — a conversation id or its exact title.
      Default: this session's own thread. Never another employee's. */
  thread: z.string().min(1).optional(),
  /** Newest-N cap after filtering; the backend default applies when omitted. */
  limit: z.int().min(1).optional(),
  /** Only messages before this seq (read further back). */
  before: z.int().min(1).optional(),
  /** Only messages after this seq (incremental re-reads). */
  afterSeq: z.int().min(0).optional(),
});
export type ThreadReadParams = z.infer<typeof ThreadReadParams>;
export const ThreadReadResult = z.object({
  /** The thread that was read — the session's own unless `thread` named one. */
  thread: z.object({
    id: z.string().min(1),
    title: z.string(),
    /** The thread's access level (#106) — `ask` = approvals reach the user. */
    access: ConversationAccess,
    /** Set while the running turn is stuck (D-#772), with the plain reason. */
    stuck: z.object({ reason: z.string().min(1) }).optional(),
  }),
  messages: z.array(AppMessage),
});
export type ThreadReadResult = z.infer<typeof ThreadReadResult>;

export const ThreadListParams = z.strictObject({});
export type ThreadListParams = z.infer<typeof ThreadListParams>;
export const ThreadListItem = z.object({
  id: z.string().min(1),
  title: z.string(),
  state: ConversationState,
  archived: z.boolean(),
  /** The thread's access level (#106). */
  access: ConversationAccess,
  /** Epoch ms of the newest message, when the thread has one. */
  lastActivity: z.int().min(0).optional(),
  /** Pull requests linked to the thread (conversations.prs). */
  prs: z.array(ForgePrListItem),
  /** True on the calling session's own thread. */
  current: z.boolean(),
});
export const ThreadListResult = z.object({
  threads: z.array(ThreadListItem),
});
export type ThreadListResult = z.infer<typeof ThreadListResult>;

export const ThreadSearchParams = z.strictObject({
  query: z.string().min(1),
  limit: z.int().min(1).max(200).optional(),
});
export type ThreadSearchParams = z.infer<typeof ThreadSearchParams>;
export const ThreadSearchResult = z.object({
  hits: z.array(MessageSearchHit),
});
export type ThreadSearchResult = z.infer<typeof ThreadSearchResult>;

export const ThreadSetTitleParams = z.strictObject({
  title: z.string().min(1),
});
export type ThreadSetTitleParams = z.infer<typeof ThreadSetTitleParams>;
export const ThreadSetTitleResult = z.object({
  /** "set" = renamed; "user_title" = the user typed the title — it wins (#137). */
  outcome: z.enum(["set", "user_title"]),
  /** The title now on the thread (unchanged on user_title). */
  title: z.string(),
});
export type ThreadSetTitleResult = z.infer<typeof ThreadSetTitleResult>;

export const ThreadPrsParams = z.strictObject({});
export type ThreadPrsParams = z.infer<typeof ThreadPrsParams>;
export const ThreadPrsResult = z.object({
  prs: z.array(ForgePrListItem),
});
export type ThreadPrsResult = z.infer<typeof ThreadPrsResult>;

/**
 * `thread_start` — open a new thread with a first message from the
 * employee. The ask names the title, the opening text and the project; on
 * approval the relay runs `conversations.open` scoped to the bound channel,
 * with the project's folder as the thread's `cwd` (the relay files it
 * there, D-#771). No `project` = a plain chat.
 */
export const ThreadStartParams = z.strictObject({
  text: z.string().min(1),
  title: z.string().min(1).optional(),
  /** A project's id or key (`project_list`); its folder becomes the new
      thread's working folder. Omitted → a plain chat. */
  project: z.string().min(1).optional(),
});
export type ThreadStartParams = z.infer<typeof ThreadStartParams>;
export const ThreadStartResult = z.object({
  conversation: z.object({
    id: z.string().min(1),
    title: z.string(),
  }),
  message: AppMessage,
});
export type ThreadStartResult = z.infer<typeof ThreadStartResult>;

/* --------------------------------- project -------------------------------- */

/** `project_list` — the company's projects: the folders it works in. */
export const ProjectListParams = z.strictObject({});
export type ProjectListParams = z.infer<typeof ProjectListParams>;
export const ProjectListResult = z.object({ projects: z.array(Project) });
export type ProjectListResult = z.infer<typeof ProjectListResult>;

/** `project_create` — propose a project for a folder; nothing is made until
    the user approves. A folder that already has a project answers it. */
export const ProjectCreateParams = z.strictObject({
  folder: z.string().min(1),
  name: z.string().min(1).optional(),
  about: z.string().optional(),
});
export type ProjectCreateParams = z.infer<typeof ProjectCreateParams>;
export const ProjectCreateResult = z.object({ project: Project });
export type ProjectCreateResult = z.infer<typeof ProjectCreateResult>;

/* ---------------------------------- work ---------------------------------- */

/**
 * Tickets and goals (D-#776). Ticket writes do not ask — the company plan
 * (#746) is that creating and updating tickets never asks. `goal_create`
 * always asks (D-#341): a goal changes the company, including one the
 * caller would own. The owner's own `goals.create` from the app does not
 * go through this tool.
 */

export const GoalListParams = z.strictObject({});
export type GoalListParams = z.infer<typeof GoalListParams>;
export const GoalListResult = z.object({ goals: z.array(GoalSchema) });
export type GoalListResult = z.infer<typeof GoalListResult>;

export const GoalCreateParams = z.strictObject({
  /** A project's id or key. */
  project: z.string().min(1),
  /** Trimmed before the approval card: a blank title never opens an ask. */
  title: z.string().trim().min(1),
  due: z.string().optional(),
  why: z.string().optional(),
  /** Employee id. Omit to propose a goal the human owns. Either way the
      tool asks before anything is written. */
  ownerId: z.string().min(1).optional(),
});
export type GoalCreateParams = z.infer<typeof GoalCreateParams>;
export const GoalCreateResult = z.object({ goal: GoalSchema });
export type GoalCreateResult = z.infer<typeof GoalCreateResult>;

export const TicketListParams = z.strictObject({
  project: z.string().min(1).optional(),
});
export type TicketListParams = z.infer<typeof TicketListParams>;
export const TicketListResult = z.object({ tickets: z.array(TicketSchema) });
export type TicketListResult = z.infer<typeof TicketListResult>;

export const TicketReadParams = z.strictObject({ id: z.string().min(1) });
export type TicketReadParams = z.infer<typeof TicketReadParams>;
export const TicketReadResult = z.object({ ticket: TicketSchema });
export type TicketReadResult = z.infer<typeof TicketReadResult>;

export const TicketCreateParams = z.strictObject({
  project: z.string().min(1),
  title: z.string().trim().min(1),
  goalId: z.string().min(1).optional(),
  ownerId: z.string().min(1).optional(),
  status: TicketStatus.optional(),
  waitingOn: TicketWaitingOn.optional(),
  progress: z.array(TicketStep).optional(),
  startsAt: z.string().optional(),
  stuckWhy: z.string().optional(),
});
export type TicketCreateParams = z.infer<typeof TicketCreateParams>;
export const TicketCreateResult = z.object({ ticket: TicketSchema });
export type TicketCreateResult = z.infer<typeof TicketCreateResult>;

export const TicketUpdateParams = z.strictObject({
  id: z.string().min(1),
  title: z.string().trim().min(1).optional(),
  goalId: z.string().min(1).nullable().optional(),
  status: TicketStatus.optional(),
  waitingOn: TicketWaitingOn.nullable().optional(),
  progress: z.array(TicketStep).optional(),
  result: TicketResultSchema.nullable().optional(),
  startsAt: z.string().nullable().optional(),
  stuckWhy: z.string().nullable().optional(),
});
export type TicketUpdateParams = z.infer<typeof TicketUpdateParams>;
export const TicketUpdateResult = z.object({
  tickets: z.array(TicketSchema),
});
export type TicketUpdateResult = z.infer<typeof TicketUpdateResult>;

export const TicketAssignParams = z.strictObject({
  id: z.string().min(1),
  /** Employee id, or "ceo" for whoever stands in until a CEO is named. */
  ownerId: z.string().min(1),
});
export type TicketAssignParams = z.infer<typeof TicketAssignParams>;
export const TicketAssignResult = z.object({
  ticket: TicketSchema,
  thread: z.object({ id: z.string().min(1), title: z.string() }),
});
export type TicketAssignResult = z.infer<typeof TicketAssignResult>;

export const TicketCommentParams = z.strictObject({
  id: z.string().min(1),
  text: z.string().trim().min(1),
});
export type TicketCommentParams = z.infer<typeof TicketCommentParams>;
export const TicketCommentResult = z.object({ ticket: TicketSchema });
export type TicketCommentResult = z.infer<typeof TicketCommentResult>;

/* --------------------------------- schedule ------------------------------- */

/** `schedule_list` — this employee's scheduled tasks (#136). */
export const ScheduleListParams = z.strictObject({});
export type ScheduleListParams = z.infer<typeof ScheduleListParams>;
export const ScheduleListResult = z.object({
  tasks: z.array(ScheduledTask),
});
export type ScheduleListResult = z.infer<typeof ScheduleListResult>;

/* The write tools propose a company change; each opens an ask card and
   nothing is written until the user approves (`access: "approval"`). The
   employee comes from the session binding — an agent can only ever task
   itself. */
export const ScheduleCreateParams = z.strictObject({
  name: z.string().min(1),
  prompt: z.string().min(1),
  folder: z.string().min(1).optional(),
  schedule: TaskSchedule,
  access: ConversationAccess,
});
export type ScheduleCreateParams = z.infer<typeof ScheduleCreateParams>;
export const ScheduleUpdateParams = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  folder: z.string().min(1).nullable().optional(),
  schedule: TaskSchedule.optional(),
  access: ConversationAccess.optional(),
  paused: z.boolean().optional(),
});
export type ScheduleUpdateParams = z.infer<typeof ScheduleUpdateParams>;
export const ScheduleTaskRef = z.strictObject({ id: z.string().min(1) });
export type ScheduleTaskRef = z.infer<typeof ScheduleTaskRef>;
export const ScheduleTaskResult = z.object({ task: ScheduledTask });
export type ScheduleTaskResult = z.infer<typeof ScheduleTaskResult>;
export const ScheduleDeletedResult = z.object({ deleted: z.literal(true) });
export type ScheduleDeletedResult = z.infer<typeof ScheduleDeletedResult>;

/* -------------------------------- registry -------------------------------- */

export interface LilosToolContract {
  params: z.ZodType;
  result: z.ZodType;
  /** One-line summary surfaced to the model as the MCP tool description. */
  doc: string;
  area: ToolArea;
  access: ToolAccess;
  /**
   * Offered only to a session whose employee held the CEO position when
   * the session started, and rejected at call time unless they still do
   * (D-#778). Absent on every other tool.
   */
  ceoOnly?: boolean;
}

export const LILOS_TOOLS: Record<string, LilosToolContract> = {
  browser_open: {
    params: BrowserOpenParams,
    result: BrowserOpenResult,
    doc: "Open a URL in the session's browser and return the loaded page.",
    area: "browser",
    access: "write",
  },
  browser_click: {
    params: BrowserClickParams,
    result: BrowserClickResult,
    doc: "Click an element by CSS selector (Playwright selector syntax).",
    area: "browser",
    access: "write",
  },
  browser_type: {
    params: BrowserTypeParams,
    result: BrowserTypeResult,
    doc: "Type text — into `selector`'s field when given, else the focused element.",
    area: "browser",
    access: "write",
  },
  browser_read: {
    params: BrowserReadParams,
    result: BrowserReadResult,
    doc: "Read the current page: url, title and visible text.",
    area: "browser",
    access: "read",
  },
  browser_scroll: {
    params: BrowserScrollParams,
    result: BrowserScrollResult,
    doc: "Scroll the page by a pixel delta (negative = up).",
    area: "browser",
    access: "write",
  },
  browser_eval: {
    params: BrowserEvalParams,
    result: BrowserEvalResult,
    doc: "Evaluate JavaScript in the page and return the JSON value.",
    area: "browser",
    access: "write",
  },
  terminal_run: {
    params: TerminalRunParams,
    result: TerminalRunResult,
    doc: "Run a shell command in the session's terminal and return its output + exit code.",
    area: "terminal",
    access: "write",
  },
  terminal_write: {
    params: TerminalWriteParams,
    result: TerminalWriteResult,
    doc: "Send raw input to the terminal (interactive programs; use terminal_run for commands).",
    area: "terminal",
    access: "write",
  },
  terminal_read: {
    params: TerminalReadParams,
    result: TerminalReadResult,
    doc: "Read the terminal's recent output (scrollback tail).",
    area: "terminal",
    access: "read",
  },
  workbench_previews: {
    params: WorkbenchPreviewsParams,
    result: WorkbenchPreviewsResult,
    doc: "List dev-server preview URLs the user's Workbench shows for this session (URL scan + PREVIEW: markers).",
    area: "workbench",
    access: "read",
  },
  workbench_open: {
    params: WorkbenchOpenTarget,
    result: WorkbenchOpenResult,
    doc: "Show the user something in this session's Workbench: `{file, line?}`, `{diff, path?}`, `{pr}`, `{url}` or `{tab:'subagents'|'background'|'plan'}` — the panel opens on that tab. A session with no folder accepts `tab` targets only (the rest error). It never opens an editor on the Mac.",
    area: "workbench",
    access: "write",
  },
  context: {
    params: ContextParams,
    result: ContextResult,
    doc: "Who and where this session is: the employee record, channel, thread, folder, context usage { used, window }, the user's name, Mac status and attached tool areas.",
    area: "root",
    access: "read",
  },
  guide: {
    params: GuideParams,
    result: GuideResult,
    doc: "LilOS docs shipped with the app — pass a topic (overview, threads, employees, approvals, workbench, mobile, gateway); none returns the index.",
    area: "root",
    access: "read",
  },
  ask: {
    params: AskParams,
    result: AskToolResult,
    doc: "Ask the user and wait. Optional why, ifYes and ifNo are the lines Needs you shows. With options, the user picks one; without them, they approve or deny.",
    area: "root",
    access: "write",
  },
  team_list: {
    params: TeamListParams,
    result: TeamListResult,
    doc: "The company roster: every employee's name, role, status, model, and who they report to.",
    area: "team",
    access: "read",
  },
  thread_post: {
    params: ThreadPostParams,
    result: ThreadPostResult,
    doc: "Post a message to this session's own thread — the user sees it in the app.",
    area: "thread",
    access: "write",
  },
  thread_read: {
    params: ThreadReadParams,
    result: ThreadReadResult,
    doc: "Read the visible messages of one of your threads — the session's own unless `thread` names another by id or title; `before`/`afterSeq` window it.",
    area: "thread",
    access: "read",
  },
  thread_list: {
    params: ThreadListParams,
    result: ThreadListResult,
    doc: "Your threads — title, state, last activity and linked PRs.",
    area: "thread",
    access: "read",
  },
  thread_search: {
    params: ThreadSearchParams,
    result: ThreadSearchResult,
    doc: "Search messages across your threads (the relay's FTS index).",
    area: "thread",
    access: "read",
  },
  thread_set_title: {
    params: ThreadSetTitleParams,
    result: ThreadSetTitleResult,
    doc: "Rename this session's thread — only while its title is auto-generated; a user-typed title wins and returns `user_title`.",
    area: "thread",
    access: "write",
  },
  thread_prs: {
    params: ThreadPrsParams,
    result: ThreadPrsResult,
    doc: "Pull requests linked to this session's thread.",
    area: "thread",
    access: "read",
  },

  thread_start: {
    params: ThreadStartParams,
    result: ThreadStartResult,
    doc: "Ask the user to start a new thread with `text` as its first message (optional `title`; optional `project` — an id or key from project_list — whose folder it works in, else a plain chat). Waits for approval; company changes always ask.",
    area: "thread",
    access: "approval",
  },
  team_hire: {
    params: TeamHireParams,
    result: TeamHireResult,
    doc: "Ask the user to hire an employee (name, role, model, instructions; `profile` reuses an existing engine profile). Waits for approval; returns the new employee record. Every agent may propose a hire, and a company with no CEO still can.",
    area: "team",
    access: "approval",
  },
  team_set_ceo: {
    params: TeamSetCeoParams,
    result: TeamSetCeoResult,
    doc: "Ask the user to give the CEO position to an employee. Everyone who reported to the previous CEO or to the owner then reports to them; they report to the owner. Waits for approval.",
    area: "team",
    access: "approval",
    /* Moving the position is the holder's proposal, and it still asks the owner. */
    ceoOnly: true,
  },
  team_update: {
    params: TeamUpdateParams,
    result: TeamUpdateResult,
    doc: "Ask the user to update your own employee record — name, role, model, instructions, or who you report to. Never edits another employee. Waits for approval.",
    area: "team",
    access: "approval",
  },
  folder_add: {
    params: FolderAddParams,
    result: FolderAddResult,
    doc: "Ask the user to add a folder to the recent-folders list so it can be picked for a session. Waits for approval.",
    area: "folder",
    access: "approval",
  },
  project_list: {
    params: ProjectListParams,
    result: ProjectListResult,
    doc: "The company's projects — name, key, folder, about. Pass a project's id or key to thread_start.",
    area: "project",
    access: "read",
  },
  project_create: {
    params: ProjectCreateParams,
    result: ProjectCreateResult,
    doc: "Ask the user to make a project of a folder (optional name, about). A folder that already has a project answers it. Waits for approval; returns the project record.",
    area: "project",
    access: "approval",
  },
  goal_list: {
    params: GoalListParams,
    result: GoalListResult,
    doc: "The company's goals — title, project, due, why.",
    area: "goal",
    access: "read",
  },
  goal_create: {
    params: GoalCreateParams,
    result: GoalCreateResult,
    doc: "Propose a goal (project id or key, title, optional due and why). Always asks before it is written. Returns the goal.",
    area: "goal",
    access: "approval",
  },
  ticket_list: {
    params: TicketListParams,
    result: TicketListResult,
    doc: "The company's tickets. Optional project (id or key) limits the list.",
    area: "ticket",
    access: "read",
  },
  ticket_read: {
    params: TicketReadParams,
    result: TicketReadResult,
    doc: "One ticket: status, owner, what it waits on, checklist, result, updates.",
    area: "ticket",
    access: "read",
  },
  ticket_create: {
    params: TicketCreateParams,
    result: TicketCreateResult,
    doc: "Create a ticket in a project (id or key). Does not ask. An owner is recorded; assigning them is ticket_assign, which opens their thread.",
    area: "ticket",
    access: "write",
  },
  ticket_update: {
    params: TicketUpdateParams,
    result: TicketUpdateResult,
    doc: "Change a ticket's title, status, waiting-on, checklist, or result. Does not ask and does not change the owner. Returns every ticket the write moved, including one that was waiting on a ticket you just finished.",
    area: "ticket",
    access: "write",
  },
  ticket_assign: {
    params: TicketAssignParams,
    result: TicketAssignResult,
    doc: "Give a ticket to one employee (ownerId, or \"ceo\" for whoever stands in). Handing a ticket to an agent is the CEO's job: only the holder's session is offered this, and with no CEO it is offered to nobody. Does not ask. Sets the owner and opens their thread in one step. Assigning again adds the next hand's thread.",
    area: "ticket",
    access: "write",
    /* #746: the CEO assigns. D2 builds on this gate (D-#778). */
    ceoOnly: true,
  },
  ticket_comment: {
    params: TicketCommentParams,
    result: TicketCommentResult,
    doc: "Add an update on a ticket, as yourself. Does not ask.",
    area: "ticket",
    access: "write",
  },
  schedule_list: {
    params: ScheduleListParams,
    result: ScheduleListResult,
    doc: "This employee's scheduled tasks — name, schedule, access level, last run.",
    area: "schedule",
    access: "read",
  },
  schedule_create: {
    params: ScheduleCreateParams,
    result: ScheduleTaskResult,
    doc: "Create a scheduled task for yourself — name, schedule, prompt, optional folder. Asks the user to approve.",
    area: "schedule",
    access: "approval",
  },
  schedule_update: {
    params: ScheduleUpdateParams,
    result: ScheduleTaskResult,
    doc: "Edit one of your scheduled tasks — only the fields given change; folder: null clears it. Asks the user to approve.",
    area: "schedule",
    access: "approval",
  },
  schedule_delete: {
    params: ScheduleTaskRef,
    result: ScheduleDeletedResult,
    doc: "Delete one of your scheduled tasks — its future runs stop. Asks the user to approve.",
    area: "schedule",
    access: "approval",
  },
  schedule_run_now: {
    params: ScheduleTaskRef,
    result: ScheduleTaskResult,
    doc: "Fire one of your scheduled tasks now — a session opens at once. Asks the user to approve.",
    area: "schedule",
    access: "approval",
  },
};
export type LilosToolName = keyof typeof LILOS_TOOLS & string;

/** The tools a scope serves — only the areas it really has attached. */
export function toolsForAreas(areas: ReadonlySet<ToolArea>): LilosToolName[] {
  return (Object.keys(LILOS_TOOLS) as LilosToolName[]).filter((name) =>
    areas.has(LILOS_TOOLS[name].area),
  );
}

/**
 * What one session is offered (D-#778). `ceoAtStart` is the snapshot from
 * session start: `team_set_ceo` and `ticket_assign` are absent unless this
 * session's employee held the position then. With no CEO, they are offered
 * to nobody — the owner does those in the app. `team_hire` is not in that
 * set. Call time checks the live holder separately.
 */
export function toolsForSession(
  areas: ReadonlySet<ToolArea>,
  ceoAtStart: boolean,
): LilosToolName[] {
  return toolsForAreas(areas).filter(
    (name) => ceoAtStart || !LILOS_TOOLS[name].ceoOnly,
  );
}

/* --------------------------- catalog rendering -------------------------- */

/**
 * The catalog row shape every catalog consumer shares (`GET /tools`, the
 * MCP `tools/list`, and each engine plugin's shipped catalog snapshot —
 * #411). One renderer, so a snapshot can't drift from what the gateway
 * serves.
 */
export function catalogRows(names: readonly string[]) {
  return names.map((name) => {
    const contract = LILOS_TOOLS[name];
    return {
      name,
      description: contract.doc,
      inputSchema: z.toJSONSchema(contract.params) as Record<string, unknown>,
      outputSchema: z.toJSONSchema(contract.result) as Record<string, unknown>,
      annotations: { readOnlyHint: contract.access === "read" },
      _meta: {
        "lilos/area": contract.area,
        "lilos/access": contract.access,
        ...(contract.ceoOnly ? { "lilos/ceoOnly": true } : {}),
      },
    };
  });
}

/** The whole catalog — what an engine caller without a session gets. */
export function toolListAll() {
  return catalogRows(Object.keys(LILOS_TOOLS));
}

/** HTTP tool API: `POST <harness>/tools/<name>` with the params as body. */
export const TOOL_PATH_PREFIX = "/tools/";

/** The MCP streamable-HTTP endpoint (`POST <harness>/mcp`). */
export const MCP_PATH = "/mcp";
