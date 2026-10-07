import { z } from "zod";
import {
  AppMessage,
  ConversationState,
  EmployeeStatus,
  WorkbenchOpenTarget,
} from "../app/domain.js";
import { MessageSearchHit, StatusComponent } from "../app/wire.js";
import { ConversationAccess } from "../engine/approvals.js";
import { ForgePrListItem } from "../host/forge.js";

/**
 * The one LilOS tool catalog (issues #36 + #337): every operation an engine
 * session can call through the Agent Gateway — the MCP streamable-HTTP
 * endpoint, the `lilos mcp` stdio server, and the `lilos` CLI all render from
 * this table, and so does the host policy. Nothing else hand-writes a tool
 * list.
 *
 * Names are canonical `<area>_<action>` ("root" tools like `context`/`guide`
 * carry no prefix). Each entry declares its `area`, its `access` level
 * (`read` is always allowed, `write` mutates the session's own surfaces,
 * `approval` asks the user first), a doc line, and Zod params/result
 * contracts.
 *
 * Scope is ambient, not an argument: the gateway binds each caller to one
 * session via its per-session bearer (or `x-lilos-session`), so an agent can
 * never address another session's browser/terminal/thread.
 */

/** Tool areas — the `tools/list` filter and the host policy speak in these. */
export const TOOL_AREAS = [
  "root",
  "thread",
  "team",
  "workbench",
  "browser",
  "terminal",
] as const;
export type ToolArea = (typeof TOOL_AREAS)[number];

/** `read` never mutates; `write` mutates this session's own surfaces;
 *  `approval` needs the user's yes (slice D wires the gate). */
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
  /** The DM between the employee and the user. */
  channel: z.object({
    id: z.string().min(1),
    kind: z.string(),
  }),
  /** This session's thread in that DM. */
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
  "dm-and-threads",
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
    }),
  ),
});
export type TeamListResult = z.infer<typeof TeamListResult>;

/* ---------------------------------- thread -------------------------------- */

/**
 * The session's own thread (its DM with the user): the gateway binds the
 * conversation from the session record — the agent can never address another
 * thread. LilOS never stores transcripts.
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
  /** Which thread of this DM — a conversation id or its exact title.
      Default: this session's own thread. Never another DM's. */
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

/* -------------------------------- registry -------------------------------- */

export interface LilosToolContract {
  params: z.ZodType;
  result: z.ZodType;
  /** One-line summary surfaced to the model as the MCP tool description. */
  doc: string;
  area: ToolArea;
  access: ToolAccess;
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
    doc: "Who and where this session is: the employee record, DM, thread, folder, context usage { used, window }, the user's name, Mac status and attached tool areas.",
    area: "root",
    access: "read",
  },
  guide: {
    params: GuideParams,
    result: GuideResult,
    doc: "LilOS docs shipped with the app — pass a topic (overview, dm-and-threads, employees, approvals, workbench, mobile, gateway); none returns the index.",
    area: "root",
    access: "read",
  },
  team_list: {
    params: TeamListParams,
    result: TeamListResult,
    doc: "The company roster: every employee's name, role, status and model.",
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
    doc: "Read the visible messages of a thread in this DM — the session's own unless `thread` names another by id or title; `before`/`afterSeq` window it.",
    area: "thread",
    access: "read",
  },
  thread_list: {
    params: ThreadListParams,
    result: ThreadListResult,
    doc: "The threads in this DM — title, state, last activity and linked PRs.",
    area: "thread",
    access: "read",
  },
  thread_search: {
    params: ThreadSearchParams,
    result: ThreadSearchResult,
    doc: "Search messages inside this DM (the relay's FTS index).",
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
};
export type LilosToolName = keyof typeof LILOS_TOOLS & string;

/** The tools a scope serves — only the areas it really has attached. */
export function toolsForAreas(areas: ReadonlySet<ToolArea>): LilosToolName[] {
  return (Object.keys(LILOS_TOOLS) as LilosToolName[]).filter((name) =>
    areas.has(LILOS_TOOLS[name].area),
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
