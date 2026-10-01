import {
  LILOS_TOOLS,
  MCP_PATH,
  renderHostPolicy,
  TOOL_PATH_PREFIX,
  toolsForAreas,
} from "@lilos/contracts/harness";
import { z } from "zod";
import type { ViewerScope } from "./backend.js";
import { SurfaceError } from "./backend.js";
import { callTool, SESSION_HEADER } from "./dispatch.js";
import {
  buildMcpInitializeResult,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  type JsonRpcId,
  jsonRpcError,
  jsonRpcResult,
  mcpToolResultError,
  parseMcpMessage,
} from "./mcpProtocol.js";

/**
 * The LilOS agent gateway's session registry (issue #337): one entry per
 * engine session — its scope, its per-session bearer token, its binding
 * (employee/channel/conversation), and any engine-side session ids aliased
 * to it (e.g. Hermes' `20261001_124426_cb5b3e`, which an engine plugin
 * carrying only its own id resolves through).
 */
export interface GatewayEntry {
  readonly session: string;
  readonly token: string;
  readonly scope: ViewerScope;
}

export class SessionRegistry {
  private readonly entries = new Map<
    string,
    GatewayEntry & { readonly aliases: Set<string> }
  >();
  private readonly aliasToSession = new Map<string, string>();

  /** Register a scope; mints its bearer token. Session id is `scope.session`. */
  add(
    scope: ViewerScope,
    init?: { token?: string; engineSessionId?: string },
  ): GatewayEntry {
    const entry = {
      session: scope.session,
      token: init?.token ?? crypto.randomUUID(),
      scope,
      aliases: new Set<string>(),
    };
    this.entries.set(entry.session, entry);
    if (init?.engineSessionId) this.bindAlias(entry, init.engineSessionId);
    return entry;
  }

  /** Point an engine id at an entry; an id that IS a session id can't be
      shadowed, and a taken alias leaves its previous owner. */
  private bindAlias(
    entry: GatewayEntry & { readonly aliases: Set<string> },
    engineSessionId: string,
  ): boolean {
    if (this.entries.has(engineSessionId)) return false;
    const previous = this.aliasToSession.get(engineSessionId);
    if (previous !== undefined && previous !== entry.session) {
      this.entries.get(previous)?.aliases.delete(engineSessionId);
    }
    this.aliasToSession.set(engineSessionId, entry.session);
    entry.aliases.add(engineSessionId);
    return true;
  }

  /** The engine's own session id is an alias for the gateway session. */
  bindEngineSession(session: string, engineSessionId: string): boolean {
    const entry = this.entries.get(session);
    if (!entry || !engineSessionId) return false;
    return this.bindAlias(entry, engineSessionId);
  }

  /** Look a caller up by gateway session id or any registered engine alias. */
  resolve(idOrAlias: string): GatewayEntry | null {
    // Session ids always win — an alias can never shadow one.
    return (
      this.entries.get(idOrAlias) ??
      this.entries.get(this.aliasToSession.get(idOrAlias) ?? "") ??
      null
    );
  }

  /** Bearer-only lookup — the token itself names the session. */
  resolveToken(token: string): GatewayEntry | null {
    for (const entry of this.entries.values()) {
      if (entry.token === token) return entry;
    }
    return null;
  }

  /** Live entries — used for shutdown (close every scope) and tests. */
  all(): IterableIterator<GatewayEntry> {
    return this.entries.values();
  }

  remove(session: string): GatewayEntry | undefined {
    const entry = this.entries.get(session);
    if (!entry) return undefined;
    this.entries.delete(session);
    // Drop only aliases still owned here — one rebound to a live session
    // belongs to its new owner.
    for (const alias of entry.aliases) {
      if (this.aliasToSession.get(alias) === session) {
        this.aliasToSession.delete(alias);
      }
    }
    return entry;
  }
}

/**
 * Caller authentication: the per-session bearer IS the identity. When the
 * caller also names a session (`x-lilos-session`, a gateway id or an engine
 * alias), the two must agree — A's token can never reach B's scope.
 */
export function resolveCaller(
  registry: SessionRegistry,
  request: Request,
): GatewayEntry | null {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;
  const named = request.headers.get(SESSION_HEADER);
  if (named) {
    const entry = registry.resolve(named);
    return entry && entry.token === token ? entry : null;
  }
  return registry.resolveToken(token);
}

/* ------------------------------------------------------------------ */

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function surfaceErrorStatus(code: SurfaceError["code"]): number {
  switch (code) {
    case "not_found":
      return 404;
    case "invalid_params":
      return 400;
    case "unavailable":
      return 503;
    case "user_control":
      return 409;
    default:
      return 500;
  }
}

/** The rendered catalog rows one session sees — shared by `GET /tools` and
    the MCP `tools/list`. Everything renders FROM `LILOS_TOOLS`. */
function toolListFor(scope: ViewerScope) {
  return toolsForAreas(scope.areas).map((name) => {
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

const MCP_MAX_BATCH_MESSAGES = 50;

async function handleMcpRequest(
  caller: GatewayEntry,
  request: {
    id: JsonRpcId;
    method: string;
    params: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  switch (request.method) {
    case "initialize":
      return jsonRpcResult(
        request.id,
        buildMcpInitializeResult({
          requestedProtocolVersion: request.params.protocolVersion,
          serverVersion: "1.0.0",
          instructions: renderHostPolicy(caller.scope.areas),
        }),
      );
    case "ping":
      return jsonRpcResult(request.id, {});
    case "tools/list":
      return jsonRpcResult(request.id, { tools: toolListFor(caller.scope) });
    case "tools/call": {
      const name = request.params.name;
      if (typeof name !== "string" || !Object.hasOwn(LILOS_TOOLS, name)) {
        return jsonRpcError(
          request.id,
          JSON_RPC_INVALID_PARAMS,
          typeof name === "string"
            ? `Unknown tool "${name}".`
            : "Missing tool name.",
        );
      }
      if (!toolsForAreas(caller.scope.areas).includes(name)) {
        return jsonRpcError(
          request.id,
          JSON_RPC_INVALID_PARAMS,
          `Tool "${name}" is not in this session's areas.`,
        );
      }
      const args =
        typeof request.params.arguments === "object" &&
        request.params.arguments !== null
          ? request.params.arguments
          : {};
      try {
        const result = await callTool(caller.scope, name, args);
        return jsonRpcResult(request.id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent:
            typeof result === "object" && result !== null ? result : {},
        });
      } catch (e) {
        return jsonRpcResult(
          request.id,
          mcpToolResultError(e instanceof Error ? e.message : String(e)),
        );
      }
    }
    default:
      return jsonRpcError(
        request.id,
        JSON_RPC_METHOD_NOT_FOUND,
        `Method "${request.method}" is not supported.`,
      );
  }
}

/**
 * The gateway HTTP surface (AC-2/AC-3):
 *   POST /tools/<name>   — the tool API (`x-lilos-session` + bearer)
 *   GET  /tools          — the session's rendered catalog
 *   POST /mcp            — MCP streamable HTTP (initialize/tools/list/tools/call)
 * Returns null for anything else so the host can keep routing.
 */
export function gatewayHandler(
  registry: SessionRegistry,
): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const url = new URL(request.url);
    const isToolsList = url.pathname === "/tools";
    const isToolCall =
      url.pathname.startsWith(TOOL_PATH_PREFIX) && request.method === "POST";
    const isMcp = url.pathname === MCP_PATH && request.method === "POST";
    if (!(isToolsList && request.method === "GET") && !isToolCall && !isMcp) {
      return null;
    }
    const caller = resolveCaller(registry, request);
    if (!caller) {
      return jsonError(401, "unauthenticated", "missing or invalid token");
    }
    if (isToolsList) {
      return Response.json({ tools: toolListFor(caller.scope) });
    }
    if (isMcp) {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json(
          jsonRpcError(null, JSON_RPC_PARSE_ERROR, "Body must be JSON-RPC"),
          { status: 400 },
        );
      }
      const messages = Array.isArray(body) ? body : [body];
      if (messages.length === 0) {
        return Response.json(
          jsonRpcError(null, JSON_RPC_INVALID_REQUEST, "Empty JSON-RPC batch."),
          { status: 400 },
        );
      }
      if (messages.length > MCP_MAX_BATCH_MESSAGES) {
        return Response.json(
          jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            `JSON-RPC batches may contain at most ${MCP_MAX_BATCH_MESSAGES} messages.`,
          ),
          { status: 400 },
        );
      }
      const responses = (
        await Promise.all(
          messages.map(async (raw) => {
            const parsed = parseMcpMessage(raw);
            switch (parsed.kind) {
              case "request":
                return handleMcpRequest(caller, parsed.request);
              case "invalid":
                return jsonRpcError(
                  parsed.id,
                  JSON_RPC_INVALID_REQUEST,
                  "Invalid JSON-RPC message.",
                );
              // notifications + stray responses acknowledge silently
              case "notification":
              case "response":
                return null;
            }
          }),
        )
      ).filter((r): r is Record<string, unknown> => r !== null);
      if (responses.length === 0) return new Response(null, { status: 202 });
      return Response.json(Array.isArray(body) ? responses : responses[0]);
    }
    // POST /tools/<name>
    const name = url.pathname.slice(TOOL_PATH_PREFIX.length);
    if (
      !Object.hasOwn(LILOS_TOOLS, name) ||
      !toolsForAreas(caller.scope.areas).includes(name)
    ) {
      return jsonError(404, "not_found", `unknown tool: ${name}`);
    }
    let args: unknown;
    try {
      args = await request.json();
    } catch {
      return jsonError(400, "invalid_params", "body must be JSON");
    }
    try {
      const result = await callTool(caller.scope, name, args);
      return Response.json({ result });
    } catch (e) {
      if (e instanceof SurfaceError) {
        return jsonError(surfaceErrorStatus(e.code), e.code, e.message);
      }
      return jsonError(
        500,
        "internal",
        e instanceof Error ? e.message : "internal error",
      );
    }
  };
}
