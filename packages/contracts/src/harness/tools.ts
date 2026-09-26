import { z } from "zod";
import { AppMessage } from "../app/domain.js";

/**
 * The LilOS tool surface (issue #36): the operations an engine session calls
 * through the LilOS MCP server — and the same operations the `lilos` CLI runs
 * against the harness HTTP tool API. Declared once here; the MCP `tools/list`
 * schemas are rendered from these Zod contracts at runtime (z.toJSONSchema).
 *
 * The surface follows spike #24's proven set: selector-first browser actions
 * for the agent (the pixel-coordinate input path is the viewer's, not the
 * agent's), marker-captured `terminal_run` vs raw `terminal_write`, and
 * preview discovery via PTY output scan + `PREVIEW:` marker — no port polling.
 *
 * Scope is ambient, not an argument: the harness binds each MCP/CLI caller to
 * one session's surfaces via its auth token (`x-lilos-session` header), so an
 * agent can never address another session's browser/terminal.
 */

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

/* --------------------------------- previews ------------------------------- */

export const PreviewTarget = z.object({
  url: z.string(),
  /** "scan" = PTY output URL match; "marker" = explicit `PREVIEW: <url>` line. */
  via: z.enum(["scan", "marker"]),
});
export type PreviewTarget = z.infer<typeof PreviewTarget>;

export const PreviewsListParams = z.strictObject({});
export type PreviewsListParams = z.infer<typeof PreviewsListParams>;
export const PreviewsListResult = z.object({
  previews: z.array(PreviewTarget),
});
export type PreviewsListResult = z.infer<typeof PreviewsListResult>;

/* --------------------------------- app ops -------------------------------- */

/**
 * Minimal app ops scoped to the session's own conversation (the env contract
 * carries channel/conversation/author ids — the agent cannot address another
 * thread). Read stays inside one conversation; LilOS never stores transcripts.
 */
export const AppPostMessageParams = z.strictObject({
  text: z.string().min(1),
});
export type AppPostMessageParams = z.infer<typeof AppPostMessageParams>;
export const AppPostMessageResult = z.object({
  message: AppMessage,
});
export type AppPostMessageResult = z.infer<typeof AppPostMessageResult>;

export const AppReadConversationParams = z.strictObject({
  /** Only messages after this seq (incremental re-reads). */
  afterSeq: z.int().min(0).optional(),
});
export type AppReadConversationParams = z.infer<
  typeof AppReadConversationParams
>;
export const AppReadConversationResult = z.object({
  messages: z.array(AppMessage),
});
export type AppReadConversationResult = z.infer<
  typeof AppReadConversationResult
>;

/* -------------------------------- registry -------------------------------- */

export interface LilosToolContract {
  params: z.ZodType;
  result: z.ZodType;
  /** One-line summary surfaced to the model as the MCP tool description. */
  doc: string;
}

export const LILOS_TOOLS: Record<string, LilosToolContract> = {
  browser_open: {
    params: BrowserOpenParams,
    result: BrowserOpenResult,
    doc: "Open a URL in the session's browser and return the loaded page.",
  },
  browser_click: {
    params: BrowserClickParams,
    result: BrowserClickResult,
    doc: "Click an element by CSS selector (Playwright selector syntax).",
  },
  browser_type: {
    params: BrowserTypeParams,
    result: BrowserTypeResult,
    doc: "Type text — into `selector`'s field when given, else the focused element.",
  },
  browser_read: {
    params: BrowserReadParams,
    result: BrowserReadResult,
    doc: "Read the current page: url, title and visible text.",
  },
  browser_scroll: {
    params: BrowserScrollParams,
    result: BrowserScrollResult,
    doc: "Scroll the page by a pixel delta (negative = up).",
  },
  browser_eval: {
    params: BrowserEvalParams,
    result: BrowserEvalResult,
    doc: "Evaluate JavaScript in the page and return the JSON value.",
  },
  terminal_run: {
    params: TerminalRunParams,
    result: TerminalRunResult,
    doc: "Run a shell command in the session's terminal and return its output + exit code.",
  },
  terminal_write: {
    params: TerminalWriteParams,
    result: TerminalWriteResult,
    doc: "Send raw input to the terminal (interactive programs; use terminal_run for commands).",
  },
  terminal_read: {
    params: TerminalReadParams,
    result: TerminalReadResult,
    doc: "Read the terminal's recent output (scrollback tail).",
  },
  previews_list: {
    params: PreviewsListParams,
    result: PreviewsListResult,
    doc: "List dev-server preview URLs discovered from terminal output (URL scan + PREVIEW: markers).",
  },
  app_post_message: {
    params: AppPostMessageParams,
    result: AppPostMessageResult,
    doc: "Post a message to this session's conversation, visible to the user in the app.",
  },
  app_read_conversation: {
    params: AppReadConversationParams,
    result: AppReadConversationResult,
    doc: "Read the visible messages of this session's conversation.",
  },
};
export type LilosToolName = keyof typeof LILOS_TOOLS & string;

/** HTTP tool API: `POST <harness>/tools/<name>` with the params as body. */
export const TOOL_PATH_PREFIX = "/tools/";
