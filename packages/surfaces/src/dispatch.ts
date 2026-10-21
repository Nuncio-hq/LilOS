import type { WorkbenchOpenTarget } from "@lilos/contracts/app";
import {
  type BrowserClickParams,
  type BrowserEvalParams,
  type BrowserOpenParams,
  type BrowserScrollParams,
  type BrowserTypeParams,
  type FolderAddParams,
  type GuideParams,
  LILOS_TOOLS,
  type ProjectCreateParams,
  type ScheduleCreateParams,
  type ScheduleTaskRef,
  type ScheduleUpdateParams,
  type TeamHireParams,
  type TeamUpdateParams,
  type TerminalReadParams,
  type TerminalRunParams,
  type TerminalWriteParams,
  type ThreadPostParams,
  type ThreadReadParams,
  type ThreadSearchParams,
  type ThreadSetTitleParams,
  type ThreadStartParams,
} from "@lilos/contracts/harness";
import { z } from "zod";
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
    /* prettifyError lists each issue as a line the calling model can act
       on (zod's raw error.message is a JSON blob) — surfaced through the
       gateway's {error:{code,message}} body so the model can correct and
       retry (#340 live-leg: bare HTTP 400s taught it nothing). */
    throw new SurfaceError(
      "invalid_params",
      `invalid params for ${name}:\n${z.prettifyError(parsed.error)}`,
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
    case "workbench_open":
      result = await backend.workbenchOpen(p as WorkbenchOpenTarget);
      break;
    case "context":
      result = await backend.context();
      break;
    case "guide":
      result = await backend.guide(p as GuideParams);
      break;
    case "team_list":
      result = await backend.teamList();
      break;
    case "schedule_list":
      result = await backend.scheduleList();
      break;
    case "schedule_create":
      result = await backend.scheduleCreate(p as ScheduleCreateParams);
      break;
    case "schedule_update":
      result = await backend.scheduleUpdate(p as ScheduleUpdateParams);
      break;
    case "schedule_delete":
      result = await backend.scheduleDelete(p as ScheduleTaskRef);
      break;
    case "schedule_run_now":
      result = await backend.scheduleRunNow(p as ScheduleTaskRef);
      break;
    case "team_hire":
      result = await backend.teamHire(p as TeamHireParams);
      break;
    case "team_update":
      result = await backend.teamUpdate(p as TeamUpdateParams);
      break;
    case "folder_add":
      result = await backend.folderAdd(p as FolderAddParams);
      break;
    case "project_list":
      result = await backend.projectList();
      break;
    case "project_create":
      result = await backend.projectCreate(p as ProjectCreateParams);
      break;

    case "thread_post":
      result = await backend.threadPost(p as ThreadPostParams);
      break;
    case "thread_read":
      result = await backend.threadRead(p as ThreadReadParams);
      break;
    case "thread_list":
      result = await backend.threadList();
      break;
    case "thread_search":
      result = await backend.threadSearch(p as ThreadSearchParams);
      break;
    case "thread_set_title":
      result = await backend.threadSetTitle(p as ThreadSetTitleParams);
      break;
    case "thread_prs":
      result = await backend.threadPrs();
      break;
    case "thread_start":
      result = await backend.threadStart(p as ThreadStartParams);
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
