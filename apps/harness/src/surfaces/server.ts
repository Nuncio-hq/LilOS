import { randomUUID } from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import type { McpServerHttp, McpServerStdio } from "@lilos/contracts/engine";
import {
  CreateGatewaySession,
  MCP_PATH,
  type SessionBinding,
} from "@lilos/contracts/harness";
import {
  type AppOps,
  attachViewer,
  type BrowserDriver,
  gatewayHandler,
  SESSION_HEADER,
  SessionRegistry,
  SessionSurfaces,
  SURFACES_ENV,
  type SurfaceHost,
} from "@lilos/surfaces";
import { type WebSocket, WebSocketServer } from "ws";
import type { Logger } from "../log";
import { ChromiumBrowser } from "./browser";
import { bunPtySpawner } from "./pty";

/**
 * The surfaces side of the workspace harness (issue #36), grown into the
 * agent gateway (issue #337): one SessionSurfaces per engine session —
 * harness-owned Chromium page and PTY shell — plus the gateway HTTP surface
 * every engine-facing consumer goes through:
 *
 *   POST /tools/<name>        the tool API (`lilos` CLI + stdio MCP call it)
 *   GET  /tools               this session's rendered catalog
 *   POST /mcp                 MCP streamable HTTP (initialize/tools/list/tools/call)
 *   GET  /view?session&token  the Workbench's live viewer socket
 *
 * The registry binds (employee/channel/conversation/cwd) per session and
 * resolves callers by per-session bearer — tool calls never carry agent-
 * passed ids (AC-3).
 */
const VIEW_PATH = "/view";
const SESSIONS_PATH = "/surfaces/sessions";

export interface CreateSessionInit {
  cwd?: string;
  binding?: SessionBinding;
  /** The engine's own session id, registered as an alias (AC-3). */
  engineSessionId?: string;
}

export interface SurfacesServerOptions {
  /** Creates the browser driver; defaults to headless Chromium. */
  createBrowser?: () => Promise<BrowserDriver>;
  /** Terminal cols/rows every scope starts with. */
  cols?: number;
  rows?: number;
  /** Per-session thread ops (relay conversation post/read), by session. */
  appOps?: (session: string, binding?: SessionBinding) => AppOps | undefined;
  log?: Logger;
  /** Absolute path of the `lilos` CLI entry engines' MCP spec points at. */
  cliPath?: string;
}

export interface SessionHandle {
  session: string;
  token: string;
  binding?: SessionBinding;
  /** The stdio `mcpServers` entry the host merges into `session.start` (AC-3). */
  mcpServer: McpServerStdio;
  /** The HTTP `mcpServers` entry — engines with the `http` MCP transport use
      this straight on the gateway (AC-2). */
  mcpServerHttp: McpServerHttp;
  /** `ws://` URL a Workbench viewer opens. */
  viewerUrl: string;
}

export interface SurfacesServer extends SurfaceHost {
  readonly url: string;
  readonly wsUrl: string;
  create(init?: CreateSessionInit): SessionHandle;
  /** Register an engine's own session id as an alias for a gateway session. */
  bindEngineSession(session: string, engineSessionId: string): boolean;
  destroy(session: string): Promise<boolean>;
  close(): Promise<void>;
}

const defaultCli = fileURLToPath(
  new URL("../../../lilos/src/cli.ts", import.meta.url),
);

export async function serveSurfaces(
  port: number,
  options: SurfacesServerOptions = {},
): Promise<SurfacesServer> {
  const registry = new SessionRegistry();
  const sockets = new Set<import("node:net").Socket>();
  const viewers = new Set<WebSocket>();
  const log = options.log;
  const gateway = gatewayHandler(registry);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    void (async () => {
      try {
        if (req.method === "POST" && url.pathname === SESSIONS_PATH) {
          const body = await readJson(req);
          const parsed = CreateGatewaySession.safeParse(body);
          if (!parsed.success) {
            return json(res, 400, {
              error: { code: "invalid_params", message: parsed.error.message },
            });
          }
          const handle = create({
            cwd: parsed.data.cwd,
            binding: parsed.data.binding,
            engineSessionId: parsed.data.engineSessionId,
          });
          return json(res, 201, handle);
        }
        if (url.pathname.startsWith(`${SESSIONS_PATH}/`)) {
          const rest = url.pathname.slice(SESSIONS_PATH.length + 1);
          if (req.method === "DELETE") {
            return json(res, (await destroy(rest)) ? 200 : 404, {});
          }
          if (req.method === "POST" && rest.endsWith("/engine")) {
            const session = rest.slice(0, -"/engine".length);
            const body = await readJson(req);
            const engineSessionId = body.engineSessionId;
            const ok =
              typeof engineSessionId === "string" &&
              bindEngineSession(session, engineSessionId);
            return json(res, ok ? 200 : 404, {});
          }
        }
        const isGateway =
          url.pathname === MCP_PATH ||
          url.pathname === "/tools" ||
          url.pathname.startsWith("/tools/");
        if (isGateway) {
          const headers: Record<string, string> = {
            "content-type": "application/json",
            authorization: req.headers.authorization ?? "",
          };
          const sessionHeader = req.headers[SESSION_HEADER];
          if (sessionHeader) headers[SESSION_HEADER] = String(sessionHeader);
          const body =
            req.method === "GET" || req.method === "HEAD"
              ? undefined
              : await readBody(req);
          const out = await gateway(
            new Request(`http://x${url.pathname}${url.search}`, {
              method: req.method ?? "GET",
              headers,
              body,
            }),
          );
          if (out) return send(res, out);
        }
        json(res, 404, { error: { code: "not_found", message: "not found" } });
      } catch (e) {
        json(res, 500, {
          error: {
            code: "internal",
            message: e instanceof Error ? e.message : "internal error",
          },
        });
      }
    })();
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== VIEW_PATH) {
      socket.destroy();
      return;
    }
    const session = url.searchParams.get("session") ?? "";
    const token = url.searchParams.get("token") ?? "";
    const entry = registry.resolve(session);
    if (!entry || entry.token !== token) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      viewers.add(ws);
      ws.on("close", () => viewers.delete(ws));
      const viewer = attachViewer(entry.scope, { send: (t) => ws.send(t) });
      ws.on("message", (data: Buffer) => viewer.receive(data.toString()));
      ws.on("close", () => viewer.detach());
    });
  });

  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const bound = server.address();
  const boundPort = typeof bound === "object" && bound ? bound.port : port;
  const httpUrl = `http://127.0.0.1:${boundPort}`;
  const wsUrl = `ws://127.0.0.1:${boundPort}`;

  function create(init: CreateSessionInit = {}): SessionHandle {
    const session = `s-${randomUUID().slice(0, 8)}`;
    const scope = new SessionSurfaces({
      session,
      cwd: init.cwd ?? process.env.HOME ?? process.cwd(),
      cols: options.cols,
      rows: options.rows,
      createBrowser:
        options.createBrowser ?? (() => Promise.resolve(new ChromiumBrowser())),
      spawnPty: bunPtySpawner,
      appOps: options.appOps?.(session, init.binding),
      binding: init.binding,
    });
    const entry = registry.add(scope, {
      engineSessionId: init.engineSessionId,
    });
    const token = entry.token;
    log?.info("surface session created", { session });
    return {
      session,
      token,
      binding: init.binding,
      viewerUrl: `${wsUrl}${VIEW_PATH}?session=${session}&token=${token}`,
      mcpServer: {
        name: "lilos",
        command: "bun",
        args: [options.cliPath ?? defaultCli, "mcp"],
        env: [
          { name: SURFACES_ENV.baseUrl, value: httpUrl },
          { name: SURFACES_ENV.token, value: token },
          { name: SURFACES_ENV.session, value: session },
        ],
      },
      mcpServerHttp: {
        type: "http",
        name: "lilos",
        url: `${httpUrl}${MCP_PATH}`,
        headers: [{ name: "Authorization", value: `Bearer ${token}` }],
      },
    };
  }

  function bindEngineSession(
    session: string,
    engineSessionId: string,
  ): boolean {
    return registry.bindEngineSession(session, engineSessionId);
  }

  async function destroy(session: string): Promise<boolean> {
    const entry = registry.remove(session);
    if (!entry) return false;
    await entry.scope.close();
    return true;
  }

  return {
    url: httpUrl,
    wsUrl,
    scopeFor: (s) => registry.resolve(s)?.scope ?? null,
    create,
    bindEngineSession,
    destroy,
    async close() {
      for (const entry of registry.all()) await entry.scope.close();
      for (const ws of viewers) ws.terminate();
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      await wss.close();
    },
  };
}

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((r) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
    });
    req.on("end", () => r(b));
  });

const readJson = async (
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> => {
  try {
    return JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const send = (res: http.ServerResponse, out: Response) => {
  res.writeHead(out.status, {
    "content-type": out.headers.get("content-type") ?? "application/json",
  });
  return out.text().then((t) => res.end(t));
};
