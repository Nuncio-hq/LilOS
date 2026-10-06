import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { equalSecret } from "@lilos/contracts/auth";
import type { McpServer, McpServerHttp } from "@lilos/contracts/engine";
import { MCP_PATH, type SessionBinding } from "@lilos/contracts/harness";
import {
  type AppOps,
  attachViewer,
  type BrowserDriver,
  gatewayHandler,
  type PtySpawner,
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
 * passed ids (AC-3). Session management (`create`, `destroy`,
 * `bindEngineSession`) is in-process only: nothing reachable over the port
 * may pick a binding or an alias.
 */
const VIEW_PATH = "/view";

interface CreateSessionInit {
  cwd?: string;
  binding?: SessionBinding;
  /** The engine's own session id, registered as an alias (AC-3). */
  engineSessionId?: string;
}

export interface SurfacesServerOptions {
  /** Creates the browser driver; defaults to headless Chromium. */
  createBrowser?: () => Promise<BrowserDriver>;
  /** PTY spawner for each session (default: the Bun terminal spawn). */
  spawnPty?: PtySpawner;
  /** Terminal cols/rows every scope starts with. */
  cols?: number;
  rows?: number;
  /** Per-session thread ops (relay conversation post/read), by session. */
  appOps?: (session: string, binding?: SessionBinding) => AppOps | undefined;
  log?: Logger;
  /** Absolute path of the `lilos` CLI entry engines' MCP spec points at. */
  cliPath?: string;
  /**
   * Engine-scoped bearer (#339): an in-process engine plugin authenticates
   * with it and names its own session via `x-lilos-session`. Minted here
   * when omitted; the harness hands it to the engine process as
   * `LILOS_ENGINE_TOKEN`. Never placed in a session's MCP spec.
   */
  engineToken?: string;
}

interface SessionHandle {
  session: string;
  token: string;
  binding?: SessionBinding;
  /** The `mcpServers` entry the host merges into `session.start` (AC-3) —
     stdio while the `lilos` CLI exists on disk (repo checkouts); in a
     packaged bundle it can't, so the HTTP spec rides instead (#539). */
  mcpServer: McpServer;
  /** The HTTP `mcpServers` entry — engines with the `http` MCP transport use
      this straight on the gateway (AC-2). */
  mcpServerHttp: McpServerHttp;
  /** `ws://` URL a Workbench viewer opens. */
  viewerUrl: string;
}

export interface SurfacesServer extends SurfaceHost {
  readonly url: string;
  readonly wsUrl: string;
  /** The engine-scoped bearer this port accepts (see options.engineToken). */
  readonly engineToken: string;
  create(init?: CreateSessionInit): SessionHandle;
  /** Register an engine's own session id as an alias for a gateway session. */
  bindEngineSession(session: string, engineSessionId: string): boolean;
  destroy(session: string): Promise<boolean>;
  close(): Promise<void>;
}

const defaultCli = fileURLToPath(
  new URL("../../../lilos/src/cli.ts", import.meta.url),
);

/* The stdio spec is a real spawn — it only makes sense while the CLI file
   exists on disk. Inside `bun build --compile` `defaultCli` resolves under
   $bunfs and a packaged bundle carries no CLI, so the session then carries
   the HTTP spec and http-capable engines keep working surfaces (#539). */
const cliExists = (cli: string): boolean => existsSync(cli);

export async function serveSurfaces(
  port: number,
  options: SurfacesServerOptions = {},
): Promise<SurfacesServer> {
  const registry = new SessionRegistry();
  const sockets = new Set<import("node:net").Socket>();
  const viewers = new Set<WebSocket>();
  const log = options.log;
  const engineToken = options.engineToken ?? randomUUID();
  const gateway = gatewayHandler(registry, { engineToken });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    void (async () => {
      try {
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
    /* #611: the session bearer is a secret — constant-time compare. */
    if (!entry || !equalSecret(entry.token, token)) {
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
      spawnPty: options.spawnPty ?? bunPtySpawner,
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
      mcpServer: cliExists(options.cliPath ?? defaultCli)
        ? {
            name: "lilos",
            command: "bun",
            args: [options.cliPath ?? defaultCli, "mcp"],
            env: [
              { name: SURFACES_ENV.baseUrl, value: httpUrl },
              { name: SURFACES_ENV.token, value: token },
              { name: SURFACES_ENV.session, value: session },
              /* #412: the engine env is allow-listed, so the spawn-marker
                 knob live checks use must be granted explicitly to reach
                 `lilos mcp`. */
              ...(process.env.LILOS_MCP_SPAWN_LOG
                ? [
                    {
                      name: "LILOS_MCP_SPAWN_LOG",
                      value: process.env.LILOS_MCP_SPAWN_LOG,
                    },
                  ]
                : []),
            ],
          }
        : {
            type: "http",
            name: "lilos",
            url: `${httpUrl}${MCP_PATH}`,
            headers: [{ name: "Authorization", value: `Bearer ${token}` }],
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
    engineToken,
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
