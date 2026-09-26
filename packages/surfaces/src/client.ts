import {
  type AppPostMessageResult,
  type AppReadConversationResult,
  type BrowserClickResult,
  type BrowserEvalResult,
  type BrowserOpenResult,
  type BrowserReadResult,
  type BrowserScrollResult,
  type BrowserTypeResult,
  LILOS_TOOLS,
  type PreviewsListResult,
  type TerminalReadResult,
  type TerminalRunResult,
  type TerminalWriteResult,
  TOOL_PATH_PREFIX,
  type ViewerClientMsg,
  ViewerServerMsg,
  type ViewerServerMsg as ViewerServerMsgT,
} from "@lilos/contracts/harness";
import type { SurfaceBackend } from "./backend.js";
import { SESSION_HEADER } from "./dispatch.js";

export interface ToolClientOptions {
  baseUrl: string;
  token: string;
  session: string;
  fetchImpl?: typeof fetch;
}

type ToolName = keyof typeof LILOS_TOOLS;

/**
 * `SurfaceBackend` over the HTTP tool API — what the MCP server and the
 * `lilos` CLI both call. Result payloads are re-validated against the same
 * contract the server uses, so a drifting backend fails loudly.
 */
export function toolBackend(opts: ToolClientOptions): SurfaceBackend {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const call = async (name: ToolName, args: unknown): Promise<unknown> => {
    const res = await fetchImpl(`${opts.baseUrl}${TOOL_PATH_PREFIX}${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.token}`,
        [SESSION_HEADER]: opts.session,
      },
      body: JSON.stringify(args),
    });
    const body = (await res.json()) as
      | { error?: { code: string; message: string } }
      | Record<string, unknown>;
    if (
      !res.ok ||
      (typeof body === "object" && body !== null && "error" in body)
    ) {
      const err =
        typeof body === "object" && body !== null && "error" in body
          ? (body as { error: { code: string; message: string } }).error
          : null;
      throw new Error(
        `${name} failed (${res.status}): ${err?.message ?? res.statusText}`,
      );
    }
    const parsed = LILOS_TOOLS[name].result.safeParse(
      (body as { result?: unknown }).result,
    );
    if (!parsed.success)
      throw new Error(`${name}: backend returned a contract-violating result`);
    return parsed.data;
  };

  return {
    browserOpen: (p) => call("browser_open", p) as Promise<BrowserOpenResult>,
    browserClick: (p) =>
      call("browser_click", p) as Promise<BrowserClickResult>,
    browserType: (p) => call("browser_type", p) as Promise<BrowserTypeResult>,
    browserRead: () => call("browser_read", {}) as Promise<BrowserReadResult>,
    browserScroll: (p) =>
      call("browser_scroll", p) as Promise<BrowserScrollResult>,
    browserEval: (p) => call("browser_eval", p) as Promise<BrowserEvalResult>,
    terminalRun: (p) => call("terminal_run", p) as Promise<TerminalRunResult>,
    terminalWrite: (p) =>
      call("terminal_write", p) as Promise<TerminalWriteResult>,
    terminalRead: (p) =>
      call("terminal_read", p) as Promise<TerminalReadResult>,
    previewsList: () =>
      call("previews_list", {}) as Promise<PreviewsListResult>,
    appPostMessage: (p) =>
      call("app_post_message", p) as Promise<AppPostMessageResult>,
    appReadConversation: (p) =>
      call("app_read_conversation", p) as Promise<AppReadConversationResult>,
  };
}

/* ------------------------------ viewer client ------------------------------ */

export interface ViewerHandle {
  /** Parsed server messages in arrival order (hello/frame/term/...). */
  readonly messages: ViewerServerMsgT[];
  send(msg: ViewerClientMsg): void;
  close(): void;
  /** Resolves when the socket closes. */
  closed: Promise<void>;
}

export interface OpenViewerOptions {
  /** `ws(s)://host:port` — `/view` is appended. */
  url: string;
  token: string;
  session: string;
  /** Called for each validated server message (also lands in `messages`). */
  onMessage?: (msg: ViewerServerMsgT) => void;
  socketFactory?: (url: string) => {
    readyState: number;
    send(d: string): void;
    close(): void;
    addEventListener(t: string, cb: (e: unknown) => void): void;
  };
}

/**
 * Workbench-side viewer socket: hello → snapshot → live frames/term events.
 * Sends takeover input back on the same socket.
 */
export function openViewer(opts: OpenViewerOptions): Promise<ViewerHandle> {
  const sep = opts.url.endsWith("/") ? "view" : "/view";
  const url = `${opts.url}${sep}?token=${encodeURIComponent(opts.token)}&session=${encodeURIComponent(opts.session)}`;
  const factory =
    opts.socketFactory ?? ((u: string) => new WebSocket(u) as never);
  const socket = factory(url);
  const messages: ViewerServerMsgT[] = [];
  return new Promise((resolve, reject) => {
    let opened = false;
    const handle: ViewerHandle = {
      messages,
      send(msg) {
        socket.send(JSON.stringify(msg));
      },
      close() {
        socket.close();
      },
      closed: new Promise<void>((res) => {
        socket.addEventListener("close", () => res());
      }),
    };
    socket.addEventListener("open", () => {
      opened = true;
      resolve(handle);
    });
    socket.addEventListener("error", () => {
      if (!opened) reject(new Error(`viewer socket failed: ${opts.url}`));
    });
    socket.addEventListener("message", (event) => {
      const text = (event as { data?: unknown }).data;
      if (typeof text !== "string") return;
      try {
        const msg = ViewerServerMsg.safeParse(JSON.parse(text));
        if (msg.success) {
          messages.push(msg.data);
          opts.onMessage?.(msg.data);
        }
      } catch {
        // malformed frame — ignore
      }
    });
  });
}
