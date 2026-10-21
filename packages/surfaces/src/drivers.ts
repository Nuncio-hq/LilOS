import type {
  AppMessage,
  Conversation,
  ConversationSummary,
  Employee,
  MessageSearchHit,
  ProfileSettings,
  Project,
  RecentFolder,
  ScheduledTask,
  SystemStatusResult,
  WorkbenchOpenTarget,
} from "@lilos/contracts/app";
import type {
  AskParams,
  AskToolResult,
  GoalCreateParams,
  GoalCreateResult,
  GoalListResult,
  ProjectCreateParams,
  ScheduleCreateParams,
  ScheduleUpdateParams,
  SessionBinding,
  TeamHireParams,
  TeamUpdateParams,
  TicketAssignParams,
  TicketAssignResult,
  TicketCommentParams,
  TicketCommentResult,
  TicketCreateParams,
  TicketCreateResult,
  TicketListResult,
  TicketReadParams,
  TicketReadResult,
  TicketUpdateParams,
  TicketUpdateResult,
  ViewerBrowserInputEvent,
} from "@lilos/contracts/harness";
import type { ForgePrListItem } from "@lilos/contracts/host";

/**
 * Drivers the host app injects per scope — the runtime-specific parts
 * (Playwright CDP, Bun.spawn terminal) stay at the app entry point.
 */
export interface BrowserDriver {
  readonly url: string | null;
  /** The page's current viewport in pixels — changes via `resize`. */
  readonly viewport: { width: number; height: number };
  /**
   * True when the driver can't serve ops anymore (page/browser gone). A
   * slow-but-live driver reports false — its calls may be retried rather
   * than rebuilt (#84).
   */
  readonly closed: boolean;
  open(url: string): Promise<{ url: string; title: string }>;
  click(selector: string): Promise<void>;
  type(text: string, selector?: string): Promise<void>;
  read(): Promise<{ url: string; title: string; text: string }>;
  scroll(dy: number): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  /** Pixel-space input — the viewer takeover path (CDP Input.dispatch*). */
  input(evt: ViewerBrowserInputEvent): void;
  navigate(url: string): void;
  /**
   * Real viewport resize (issue #56 AC-4) — the page's own dimensions change
   * (`page.setViewportSize`-equivalent), so the viewer's pane fits without
   * letterboxing instead of CSS-scaling a fixed-size page.
   */
  resize(size: { width: number; height: number }): Promise<void>;
  /** Screencast on/off — the hub drives this from viewer count. */
  setCasting(on: boolean): void;
  onFrame(cb: (jpeg: Uint8Array) => void): void;
  onUrl(cb: (url: string) => void): void;
  close(): Promise<void>;
}

export interface PtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtySpawnOptions {
  cols: number;
  rows: number;
  cwd?: string;
}
export type PtySpawner = (
  opts: PtySpawnOptions,
  onData: (chunk: Uint8Array) => void,
  onExit: (code: number) => void,
) => PtyHandle;

/**
 * The app leg (#340): every channel/company read or write the thread tools
 * make — backed by the relay in production. Domain-shaped ops only; tool
 * semantics (windows, name resolution, roll-ups) live in `SessionSurfaces`
 * so tests exercise them through one fake.
 */
export interface AppOps {
  postMessage(text: string): Promise<AppMessage>;
  /** Full visible history of one thread of the bound employee, seq-ascending.
      `conversationId` omitted = the bound thread itself. */
  readConversation(opts?: {
    conversationId?: string;
    afterSeq?: number;
  }): Promise<AppMessage[]>;
  /** Every conversation of the bound employee (`conversations.list` on its
      channel — the internal routing scope, D-#25). */
  listThreads(): Promise<Conversation[]>;
  /** List-row detail for the bound employee's threads (`conversations.summaries`). */
  threadSummaries(): Promise<ConversationSummary[]>;
  /** The company roster (`employees.list`). */
  employees(): Promise<Employee[]>;
  /** The bound employee's scheduled tasks (`schedules.list`). */
  scheduledTasks(employeeId: string): Promise<ScheduledTask[]>;
  /** The company's projects (`projects.list`, D-#771). */
  projects(): Promise<Project[]>;
  /** PRs linked to a thread of the bound employee (`conversations.prs`). */
  threadPrs(conversationId: string): Promise<ForgePrListItem[]>;
  /** FTS search over the bound employee's threads (`messages.search`). */
  searchMessages(query: string, limit?: number): Promise<MessageSearchHit[]>;
  /** Rename the bound thread; "user_title" when the user's title wins (#137). */
  setThreadTitle(
    title: string,
  ): Promise<{ outcome: "set" | "user_title"; title: string }>;
  /** `system.status` — the Mac's leg health, for `context`. */
  status(): Promise<SystemStatusResult>;
  /** `profile.get` — the signed-in human's LilOS identity. */
  profile(): Promise<ProfileSettings>;
  /** Emit `workbench.opened` on the bound thread's channel (`workbench.open`). */
  openWorkbench(target: WorkbenchOpenTarget): Promise<void>;
  /**
   * Approval-gated company writes: each op posts the ask card itself
   * and applies its change only after the user approves — the surfaces
   * layer never sees an unapproved write. A `declined` outcome throws
   * `SurfaceError("declined", …)`.
   */
  /** Start a new thread for the bound employee (`conversations.open` on
      approve). `project` is a project's id or key (D-#771): the op resolves
      it against `projects.list` and opens the thread with that project's
      folder as its `cwd`; omitted → a plain chat. An unknown value throws
      before any ask opens. */
  startThread(p: {
    text: string;
    title?: string;
    project?: string;
  }): Promise<{ conversation: Conversation; message: AppMessage }>;
  /** Hire an employee (`agents.create`? + `employees.create` + `channels.openDm` on approve). */
  hireEmployee(p: TeamHireParams): Promise<Employee>;
  /** Edit the calling employee's own record (`employees.update` + `agents.update` on approve). */
  updateSelf(p: TeamUpdateParams): Promise<Employee>;
  /** Add a folder to recent folders (`folders.add` on approve). */
  addFolder(path: string): Promise<RecentFolder>;
  /** Create a scheduled task for the bound employee (`schedules.create` on approve). */
  scheduleCreate(p: ScheduleCreateParams): Promise<ScheduledTask>;
  /** Edit a scheduled task (`schedules.update` on approve). */
  scheduleUpdate(p: ScheduleUpdateParams): Promise<ScheduledTask>;
  /** Delete a scheduled task (`schedules.delete` on approve). */
  scheduleDelete(id: string): Promise<void>;
  /** Fire a scheduled task now (`schedules.runNow` on approve). */
  scheduleRunNow(id: string): Promise<ScheduledTask>;
  /** Make a project of a folder (`projects.create` on approve); a folder
      that already has a project answers it. */
  createProject(p: ProjectCreateParams): Promise<Project>;
  /** Goals (D-#776). `createGoal` asks unless `ownerId` is the bound employee. */
  goals(): Promise<GoalListResult["goals"]>;
  createGoal(p: GoalCreateParams): Promise<GoalCreateResult["goal"]>;
  /** Ticket writes do not ask (#746). Assign opens the owner's thread. */
  tickets(project?: string): Promise<TicketListResult["tickets"]>;
  readTicket(p: TicketReadParams): Promise<TicketReadResult["ticket"]>;
  createTicket(p: TicketCreateParams): Promise<TicketCreateResult["ticket"]>;
  updateTicket(p: TicketUpdateParams): Promise<TicketUpdateResult>;
  assignTicket(p: TicketAssignParams): Promise<TicketAssignResult>;
  commentTicket(p: TicketCommentParams): Promise<TicketCommentResult["ticket"]>;
  /**
   * `ask` (D-#773): post a question or a once/deny approval and wait.
   * A decline throws `SurfaceError("declined")`.
   */
  askUser(p: AskParams): Promise<AskToolResult>;
}

export interface SurfaceScopeOptions {
  session: string;
  cwd: string;
  cols?: number;
  rows?: number;
  /** Lazily launched on first browser op / navigate — an idle session costs no Chromium. */
  createBrowser?: () => Promise<BrowserDriver>;
  spawnPty: PtySpawner;
  appOps?: AppOps;
  /** Who/what the session is bound to (employee/channel/conversation) — #337. */
  binding?: SessionBinding;
  /** Scrollback cap; default 400 KB like the spike's ring. */
  termTailBytes?: number;
  runTimeoutMs?: number;
  /**
   * Bound on one browser driver op (resize); a wedged call drops and
   * rebuilds the driver instead of pinning the resize serializer (#84).
   */
  browserOpTimeoutMs?: number;
}
