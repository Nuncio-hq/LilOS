import { z } from "zod";
import { AppMessage } from "../app/domain.js";

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
  /** Only messages after this seq (incremental re-reads). */
  afterSeq: z.int().min(0).optional(),
});
export type ThreadReadParams = z.infer<typeof ThreadReadParams>;
export const ThreadReadResult = z.object({
  messages: z.array(AppMessage),
});
export type ThreadReadResult = z.infer<typeof ThreadReadResult>;

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
    doc: "Read the visible messages of this session's own thread.",
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

/** HTTP tool API: `POST <harness>/tools/<name>` with the params as body. */
export const TOOL_PATH_PREFIX = "/tools/";

/** The MCP streamable-HTTP endpoint (`POST <harness>/mcp`). */
export const MCP_PATH = "/mcp";
