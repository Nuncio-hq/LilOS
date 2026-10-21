import type { ReactNode } from "react";
import type {
  EmpFn,
  Employee,
  HostAccessors,
  HumanFn,
  MergeMethod,
  OsApp,
  OsEditor,
  PullRequest,
  ShipBar,
  ShipHandlers,
  Thread,
  WbSpot,
  WbTab,
  Work,
} from "../types";
import type { LiveSurfaces } from "./live";

/** What the workbench is given: the thread it reads, the host that answers for
    its folder, and the callbacks the app wires per engine capability (a
    missing one hides its control, D-#19). */
export type WorkbenchProps = {
  thread: Thread;
  work: Work | null;
  isDM: boolean;
  lead?: Employee;
  tab: WbTab;
  setTab: (t: WbTab) => void;
  onClose: () => void;
  onStart?: () => void;
  /** True while the "asks to start work" card is open: it is the single entry point (issue #15). */
  startYields?: boolean;
  onSend?: (t: string) => void;
  /* `{error:true}` marks a failed action — the host toasts it with the
     destructive accent instead of a neutral note (#423). */
  say?: (t: string, opts?: { error?: boolean }) => void;
  repoFiles?: string[];
  /** Live host accessors for the session's real cwd (issue #11 fs/git, #37 forge). */
  host?: HostAccessors;
  human: HumanFn;
  onPrComment?: (t: string) => void | Promise<void>;
  onPrMerge?: (method: MergeMethod) => void | Promise<void>;
  /** Live harness surfaces (issue #36): replaces the mock Terminal/Preview tabs. */
  live?: LiveSurfaces;
  /** A turn is running — Changes/Files poll while the agent edits (#114 AC-3). */
  running?: boolean;
  /** A user send is relay-accepted but the feed hasn't surfaced a turn for
      it yet (#315's waiting tray). The ship bar hides Suggest across that
      gap — turn start lags the relay message that already renders (#396). */
  sendPending?: boolean;
  /** The engine declares `steer`: Send-to-agent labels the mid-turn route
      (issue #108); absent → plain "Send". */
  steer?: boolean;
  /* os.editors + a bound os.open (issue #110, same pair ThreadView takes):
     the caller probes `host.describe` — onOpenPath={null} means os.open was
     absent, so rows show no open menu even when the accessors object
     statically carries the method (D-#19). Undefined keeps the component's
     own host.osEditors/osOpen path (prototype). */
  editors?: OsEditor[];
  onOpenPath?: ((path: string, app: OsApp, line?: number) => void) | null;
  /** Stops a background process (issue #170); absent = no Stop button. */
  onStopJob?: (id: string) => void;
  /** This thread's own browser tabs (the LilOS Browser in thread mode,
      issue #214). When passed, the Preview tab becomes **Browser** and shows it. */
  browser?: ReactNode;
  /** Resolves employee helpers on the Subagents tab (#317); absent = no Subagents tab. */
  emp?: EmpFn;
  /** Opens an employee helper's own session from its Subagents row (issue #170). */
  onOpenSession?: (employeeId: string, session: string) => void;
  /** The session's `workbench_open` request (issue #340): the panel opens on
      the target's tab — a changed file's diff or a file view at its line,
      the changes view, the PR tab, the preview (a URL the caller navigates
      its Browser surface to), or an engine tab (#543's `tab` targets — the
      only kind a folderless session accepts). */
  spot?: WbSpot;
  /** Reports the settled tab set — null while the first probe is still in
      flight — so the caller can hide the toggle when there's nothing to
      show (D-#19, #543 AC-5). */
  onAllowed?: (tabs: WbTab[] | null) => void;
  /** Engine capability flags for the engine-owned tabs (#587 AC-1): the
      caller reads them off `describe` — `true` makes the tab a fixed
      member of the strip (greyed while empty), so content arriving only
      unmutes it, never moves it. Absent = content/emp fallback (mock). */
  caps?: { plan?: boolean; subagents?: boolean; background?: boolean };
  /** The commit-message Suggest (#584): a side ask the app forwards to
      the engine's `session.ask` — no transcript entry. Gets the checked
      file paths; resolves with the suggested message, which the bar
      writes into `message` through `onMessage`. */
  onSuggest?: (files: string[]) => Promise<string | void> | string | void;
  /** Live `forge.pr` truth reported upward (#579): the header's "PR #N"
      chip reads it, so a just-created or merged PR shows without waiting
      for the next `conversations.prs` refresh. */
  onPr?: (pr: PullRequest | null) => void;
  /** The commit → push → Create PR bar's mock seam (issue #107/#359): the
     prototype/app supplies state overrides + the action handlers here; a
     missing handler hides its control (D-#19). In live mode the same bar
     is built from the host's git.* + forge.* accessors instead. */
  ship?: Partial<ShipBar> & ShipHandlers;
};
