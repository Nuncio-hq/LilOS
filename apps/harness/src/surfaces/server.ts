import { randomUUID } from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import type { McpServerStdio } from "@lilos/contracts/engine";
import {
  type AppOps,
  attachViewer,
  type BrowserDriver,
  SESSION_HEADER,
  SessionSurfaces,
  SURFACES_ENV,
  type SurfaceHost,
  toolApiHandler,
  type ViewerScope,
} from "@lilos/surfaces";
import { type WebSocket, WebSocketServer } from "ws";
import type { Logger } from "../log";
import { ChromiumBrowser } from "./browser";
import { bunPtySpawner } from "./pty";

/**
 * The surfaces side of the workspace harness (issue #36, AC-1..AC-5):
 * one SessionSurfaces per engine session — harness-owned Chromium page and
 * PTY shell — plus the HTTP tool API (`POST /tools/<tool>`) the LilOS MCP
 * server and `lilos` CLI call, and the `/view` WebSocket the Workbench
 * attaches to.
 */
const VIEW_PATH = "/view";
const SESSIONS_PATH = "/surfaces/sessions";

export interface SurfacesServerOptions {
  /** Creates the browser driver; defaults to headless Chromium. */
  createBrowser?: () => Promise<BrowserDriver>;
  /** Terminal cols/rows every scope starts with. */
  cols?: number;
  rows?: number;
  /** Per-session app-ops wiring (relay conversation post/read), by session id. */
  appOps?: (session: string) => AppOps | undefined;
  log?: Logger;
  /** Absolute path of the `lilos` CLI entry engines' MCP spec points at. */
  cliPath?: string;
}

export interface SessionHandle {
  session: string;
  token: string;
  /** The `mcpServers` entry the host merges into `session.start` (AC-3). */
  mcpServer: McpServerStdio;
  /** `ws://` URL a Workbench viewer opens. */
  viewerUrl: string;
}

export interface SurfacesServer extends SurfaceHost {
  readonly url: string;
  readonly wsUrl: string;
  create(cwd?: string): SessionHandle;
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
  const scopes = new Map<string, { scope: ViewerScope; token: string }>();
  const sockets = new Set<import("node:net").Socket>();
  const viewers = new Set<WebSocket>();
  const log = options.log;

  const httpTools = toolApiHandler(
    { scopeFor: (s) => scopes.get(s)?.scope ?? null },
    {
      scopeFor(request) {
        const auth = request.headers.get("authorization") ?? "";
        const session = request.headers.get(SESSION_HEADER) ?? "";
        const entry = scopes.get(session);
        if (!entry || auth !== `Bearer ${entry.token}`) return null;
        return session;
      },
    },
  );

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    void (async () => {
      try {
        if (req.method === "POST" && url.pathname === SESSIONS_PATH) {
          const body = await readJson(req);
          const handle = create(
            typeof body.cwd === "string" ? body.cwd : undefined,
          );
          return json(res, 201, handle);
        }
        if (
          req.method === "DELETE" &&
          url.pathname.startsWith(`${SESSIONS_PATH}/`)
        ) {
          const id = url.pathname.slice(SESSIONS_PATH.length + 1);
          return json(res, (await destroy(id)) ? 200 : 404, {});
        }
        if (url.pathname.startsWith("/tools/")) {
          const out = await httpTools(
            new Request(`http://x${url.pathname}${url.search}`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: req.headers.authorization ?? "",
                [SESSION_HEADER]: String(req.headers[SESSION_HEADER] ?? ""),
              },
              body: await readBody(req),
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
    const entry = scopes.get(session);
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

  function create(cwd?: string): SessionHandle {
    const session = `s-${randomUUID().slice(0, 8)}`;
    const token = randomUUID();
    const scope = new SessionSurfaces({
      session,
      cwd: cwd ?? process.env.HOME ?? process.cwd(),
      cols: options.cols,
      rows: options.rows,
      createBrowser:
        options.createBrowser ?? (() => Promise.resolve(new ChromiumBrowser())),
      spawnPty: bunPtySpawner,
      appOps: options.appOps?.(session),
    });
    scopes.set(session, { scope, token });
    log?.info("surface session created", { session });
    return {
      session,
      token,
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
    };
  }

  async function destroy(session: string): Promise<boolean> {
    const entry = scopes.get(session);
    if (!entry) return false;
    scopes.delete(session);
    await entry.scope.close();
    return true;
  }

  return {
    url: httpUrl,
    wsUrl,
    scopeFor: (s) => scopes.get(s)?.scope ?? null,
    create,
    destroy,
    async close() {
      for (const { scope } of scopes.values()) await scope.close();
      scopes.clear();
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
