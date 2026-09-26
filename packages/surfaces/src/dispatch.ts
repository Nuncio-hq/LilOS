import {
  type AppPostMessageParams,
  type AppReadConversationParams,
  type BrowserClickParams,
  type BrowserEvalParams,
  type BrowserOpenParams,
  type BrowserScrollParams,
  type BrowserTypeParams,
  LILOS_TOOLS,
  type TerminalReadParams,
  type TerminalRunParams,
  type TerminalWriteParams,
  TOOL_PATH_PREFIX,
} from "@lilos/contracts/harness";
import { type SurfaceBackend, SurfaceError } from "./backend.js";

/**
 * One dispatch shared by the MCP server and the harness's tool HTTP API:
 * validate params against the contract, run the backend op, return the
 * contract-shaped result. Adding a tool = one entry in LILOS_TOOLS plus one
 * backend method — both sides pick it up from here.
 */
export async function callTool(
  backend: SurfaceBackend,
  name: string,
  args: unknown,
): Promise<unknown> {
  const contract = LILOS_TOOLS[name];
  if (!contract) throw new SurfaceError("not_found", `unknown tool: ${name}`);
  const parsed = contract.params.safeParse(args ?? {});
  if (!parsed.success)
    throw new SurfaceError(
      "invalid_params",
      `invalid params for ${name}: ${parsed.error.message}`,
    );
  const p = parsed.data;
  let result: unknown;
  switch (name) {
    case "browser_open":
      result = await backend.browserOpen(p as BrowserOpenParams);
      break;
    case "browser_click":
      result = await backend.browserClick(p as BrowserClickParams);
      break;
    case "browser_type":
      result = await backend.browserType(p as BrowserTypeParams);
      break;
    case "browser_read":
      result = await backend.browserRead();
      break;
    case "browser_scroll":
      result = await backend.browserScroll(p as BrowserScrollParams);
      break;
    case "browser_eval":
      result = await backend.browserEval(p as BrowserEvalParams);
      break;
    case "terminal_run":
      result = await backend.terminalRun(p as TerminalRunParams);
      break;
    case "terminal_write":
      result = await backend.terminalWrite(p as TerminalWriteParams);
      break;
    case "terminal_read":
      result = await backend.terminalRead(p as TerminalReadParams);
      break;
    case "previews_list":
      result = await backend.previewsList();
      break;
    case "app_post_message":
      result = await backend.appPostMessage(p as AppPostMessageParams);
      break;
    case "app_read_conversation":
      result = await backend.appReadConversation(
        p as AppReadConversationParams,
      );
      break;
    default:
      throw new SurfaceError("not_found", `unhandled tool: ${name}`);
  }
  const checked = contract.result.safeParse(result);
  if (!checked.success)
    throw new SurfaceError(
      "internal",
      `backend returned malformed result for ${name}`,
    );
  return checked.data;
}

export interface ToolApiAuth {
  /** Resolve the session scope from the request; null = unauthorized. */
  scopeFor(request: Request): string | null;
}

/**
 * The harness tool API as a plain fetch handler — `POST /tools/<name>` with
 * the params as the JSON body, `x-lilos-session` carrying the caller's scope.
 * Runtime-neutral: any HTTP server (Hono, Bun.serve, the test harness) mounts
 * it. Errors map to `{ error: { code, message } }` with a matching status.
 */
export function toolApiHandler(
  host: { scopeFor(session: string): SurfaceBackend | null },
  auth: ToolApiAuth,
): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const url = new URL(request.url);
    if (
      request.method !== "POST" ||
      !url.pathname.startsWith(TOOL_PATH_PREFIX)
    ) {
      return null;
    }
    const name = url.pathname.slice(TOOL_PATH_PREFIX.length);
    const session = auth.scopeFor(request);
    if (session === null)
      return jsonError(401, "unauthenticated", "missing or invalid token");
    const scope = host.scopeFor(session);
    if (!scope)
      return jsonError(404, "not_found", `no surface scope ${session}`);
    let args: unknown;
    try {
      args = await request.json();
    } catch {
      return jsonError(400, "invalid_params", "body must be JSON");
    }
    try {
      const result = await callTool(scope, name, args);
      return Response.json({ result });
    } catch (e) {
      if (e instanceof SurfaceError) {
        const status =
          e.code === "not_found"
            ? 404
            : e.code === "invalid_params"
              ? 400
              : e.code === "unavailable"
                ? 503
                : 500;
        return jsonError(status, e.code, e.message);
      }
      return jsonError(
        500,
        "internal",
        e instanceof Error ? e.message : "internal error",
      );
    }
  };
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/** `x-lilos-session` header — the per-session scope the caller is bound to. */
export const SESSION_HEADER = "x-lilos-session";
