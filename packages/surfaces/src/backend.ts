import type {
  AppPostMessageResult,
  AppReadConversationResult,
  BrowserClickResult,
  BrowserEvalResult,
  BrowserOpenResult,
  BrowserReadResult,
  BrowserScrollResult,
  BrowserTypeResult,
  PreviewsListResult,
  PreviewTarget,
  TerminalReadResult,
  TerminalRunResult,
  TerminalWriteResult,
  ViewerBrowserInputEvent,
} from "@lilos/contracts/harness";

/**
 * The seam between the tool surface (MCP server, `lilos` CLI, tool HTTP API)
 * and whatever owns the actual browser/PTY/app state — the harness in
 * production (issue #36), a fixture in tests. Methods are named after the
 * tools they back; scope resolution happens one level up (`SurfaceHost`).
 *
 * "Owner" = the piece of the harness that keeps the browser page and the PTY
 * alive with zero viewers; the Workbench viewer is a *subscriber*, never the
 * owner (spike #24 finding 2: cast only while watched).
 */
export interface SurfaceBackend {
  browserOpen(p: { url: string }): Promise<BrowserOpenResult>;
  browserClick(p: { selector: string }): Promise<BrowserClickResult>;
  browserType(p: {
    selector?: string;
    text: string;
  }): Promise<BrowserTypeResult>;
  browserRead(): Promise<BrowserReadResult>;
  browserScroll(p: { dy: number }): Promise<BrowserScrollResult>;
  browserEval(p: { expression: string }): Promise<BrowserEvalResult>;
  terminalRun(p: {
    command: string;
    timeoutMs?: number;
  }): Promise<TerminalRunResult>;
  terminalWrite(p: { data: string }): Promise<TerminalWriteResult>;
  terminalRead(p: { tailBytes?: number }): Promise<TerminalReadResult>;
  previewsList(): Promise<PreviewsListResult>;
  appPostMessage(p: { text: string }): Promise<AppPostMessageResult>;
  appReadConversation(p: {
    afterSeq?: number;
  }): Promise<AppReadConversationResult>;
}

/**
 * Everything a viewer socket can push at a scope beyond tool calls: raw
 * terminal input and pixel-space browser input (the human takeover path).
 * Implemented by the same scope object that backs the tools.
 */
export interface ViewerScope extends SurfaceBackend {
  readonly session: string;
  /** Page-space input (viewer takeover) — CDP Input.dispatch* territory. */
  browserInput(evt: ViewerBrowserInputEvent): void;
  terminalInput(data: string): void;
  terminalResize(cols: number, rows: number): void;
  browserNavigate(url: string): void;
  /** Current snapshot for a just-attached viewer. */
  snapshot(): ViewerSnapshot;
  /** Live events a viewer renders (frames, terminal bytes, url, previews). */
  subscribe(listener: (msg: ViewerScopeEvent) => void): () => void;
  /** Viewer count bookkeeping drives screencast on/off (cast only while watched). */
  readonly viewerCount: number;
  /** Tears down the owned browser + PTY (session end / host shutdown). */
  close(): Promise<void>;
}

export interface ViewerSnapshot {
  page: { width: number; height: number };
  terminal: { cols: number; rows: number };
  url: string | null;
  previews: PreviewTarget[];
  /** Latest JPEG frame (raw bytes); null until the first screencast lands. */
  lastFrame: Uint8Array | null;
  /** Terminal scrollback tail bytes (bounded ring). */
  termTail: Uint8Array;
}

export type ViewerScopeEvent =
  | { kind: "frame"; jpeg: Uint8Array; capturedAt: number }
  | { kind: "term"; data: Uint8Array }
  | { kind: "url"; url: string | null }
  | { kind: "previews"; previews: PreviewTarget[] }
  | {
      kind: "activity";
      tool: string;
      status: "started" | "completed" | "failed";
      summary: string;
      at: number;
    };

/**
 * Resolves the session scope an MCP/CLI caller or viewer is bound to. The
 * harness owns the map (one scope per engine session); the HTTP/WS layers
 * only carry `x-lilos-session` / `?session=`.
 */
export interface SurfaceHost {
  /** Null when the id is unknown — callers surface a 404/error. */
  scopeFor(session: string): ViewerScope | null;
}

/** Structured failure for backend/dispatch errors (transport maps to HTTP/RPC). */
export class SurfaceError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_params" | "unavailable" | "internal",
    message: string,
  ) {
    super(message);
    this.name = "SurfaceError";
  }
}
