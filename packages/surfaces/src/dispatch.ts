import {
  type BrowserClickParams,
  type BrowserEvalParams,
  type BrowserOpenParams,
  type BrowserScrollParams,
  type BrowserTypeParams,
  LILOS_TOOLS,
  type TerminalReadParams,
  type TerminalRunParams,
  type TerminalWriteParams,
  type ThreadPostParams,
  type ThreadReadParams,
} from "@lilos/contracts/harness";
import { type SurfaceBackend, SurfaceError } from "./backend.js";

/**
 * One dispatch shared by the agent gateway (HTTP `/tools/*` + `/mcp`), the
 * stdio MCP server, and the `lilos` CLI: validate params against the
 * contract, run the backend op, return the contract-shaped result. Adding a
 * tool = one entry in LILOS_TOOLS plus one backend method — every surface
 * picks it up from here.
 */
export async function callTool(
  backend: SurfaceBackend,
  name: string,
  args: unknown,
): Promise<unknown> {
  const contract = Object.hasOwn(LILOS_TOOLS, name)
    ? LILOS_TOOLS[name]
    : undefined;
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
    case "workbench_previews":
      result = await backend.workbenchPreviews();
      break;
    case "thread_post":
      result = await backend.threadPost(p as ThreadPostParams);
      break;
    case "thread_read":
      result = await backend.threadRead(p as ThreadReadParams);
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

/** `x-lilos-session` header — a caller may name its session (a gateway id or
    an engine alias); it must agree with the bearer token. */
export const SESSION_HEADER = "x-lilos-session";
