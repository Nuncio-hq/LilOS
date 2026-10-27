import type { AppMessage, Conversation, Employee } from "@lilos/contracts/app";
import type { PlanAction, QueuedTrayItem, V3Status } from "@lilos/ui";
import type {
  AttachedFile,
  Channel,
  ConversationAccess,
  EmpFn,
  FileMention,
  ModelChoice,
  ModelOption,
  ModelPickerExtras,
  Msg,
  OsApp,
  PullRequest,
  SlashItem,
  Thread,
  TranscriptNote,
  Employee as UiEmployee,
  WbSpot,
  Work,
} from "@lilos/ui/types";
import type { OsEditor } from "../lib/host";

/** Everything one conversation's views read — derived from the runtime atoms
    by `useThreadWith`, rendered by `ThreadPane` / `SessionPane`. */
export interface ThreadData {
  conv: Conversation;
  employeeId: string;
  employee: Employee;
  uiEmp: UiEmployee;
  uiChannel: Channel;
  empFn: EmpFn;
  mentionables: UiEmployee[];

  rootMsg: Extract<Msg, { kind: "msg" }>;
  thread: Thread;
  /** The one status word the header pill shows (`threadStatus`, D-#33). */
  status: V3Status;
  /** askId → receipt label of a resolved card. */
  resolved: Record<string, string>;

  running: boolean;
  steer: boolean;
  agentWorking: boolean;
  reconnecting: boolean;
  planCap: boolean;
  jobsCapable: boolean;
  transcriptNote: TranscriptNote | undefined;
  pending: QueuedTrayItem[];

  draft: string;
  setDraft: (v: string) => void;
  lastSent: string | undefined;
  send: (text: string, files?: AttachedFile[]) => Promise<unknown>;
  onPlan: (a: PlanAction, planId: string) => void;
  onStop: (() => void) | undefined;
  onRetry: () => void;
  onCompact: (() => void) | undefined;
  onContinue: () => void;

  models: ModelOption[] | undefined;
  defaultModel: string | undefined;
  defaultProvider: string | undefined;
  picker: ModelPickerExtras | undefined;
  /* #895: the model of a runtime thread whose catalog hasn't landed — the
     composer shows it as a read-only chip, never Hermes's list. */
  modelStatic: string | undefined;
  modelOpen: boolean;
  setModelOpen: (open: boolean) => void;
  onModel: (c: ModelChoice) => void | Promise<unknown>;
  onAccess: (a: ConversationAccess) => void;
  /* #884: the engine reports `off` — the access pill warns + fixes. */
  engineOff: boolean;
  engineName: string | undefined;
  onFixPolicy: () => void;
  onCommand: (name: string, args: string) => boolean;
  searchFiles: ((q: string) => Promise<FileMention[]>) | undefined;
  searchCommands: ((q: string) => Promise<SlashItem[]>) | undefined;

  onRewind: ((messageId: string) => void) | undefined;
  rewindWarning: string | undefined;
  seedFiles: AttachedFile[] | undefined;
  clearSeed: () => void;
  /** The committed rewind that restored files only (AC-3), when it's this thread's. */
  filesOnly: { filesRestored: boolean; target: AppMessage } | null;
  /** A fresh thread seeded from the surviving transcript; resolves to it. */
  startFresh: (target: AppMessage) => Promise<Conversation | undefined>;

  onRemovePending: (i: number) => void;
  onUnqueue: (i: number) => void;
  onSendQueued: (i: number) => void;

  /** `null` = os.open isn't on this host; `[]` = no editor found (Reveal only). */
  editors: OsEditor[] | null;
  openPath: ((path: string, app: OsApp, line?: number) => void) | undefined;
  /** The "Add a folder" move target dialog's open state (folder-less thread). */
  moveFolderOpen: boolean;
  setMoveFolderOpen: (open: boolean) => void;

  /** The folder the session works in (absent → no Workbench folder tabs). */
  work: Work | null;
  onStopJob: ((jobId: string) => void) | undefined;
  wbSpot: WbSpot | undefined;
  onPr: (pr: PullRequest | null) => void;
  onSuggest: ((files: string[]) => Promise<string>) | undefined;
  caps: { plan: boolean; subagents: boolean; background: boolean };

  historyFailed: boolean;
  retryHistory: () => void;

  /** A subagent row's session → the thread it lives in, else just its agent. */
  resolveSession: (
    empRef: string,
    sessionRef: string,
  ) => { conversationId?: string; employeeId: string };
}
