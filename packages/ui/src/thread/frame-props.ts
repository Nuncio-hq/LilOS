import type { ReactNode } from "react";
import type { QueuedTrayItem } from "../chat/agent-chat";
import type { PlanAction } from "../conversation/plan-card";
import type { QuestionAnswer } from "../conversation/question-card";
import type {
  AttachedFile,
  Channel,
  ConversationAccess,
  EmpFn,
  Employee,
  FileMention,
  HumanFn,
  ModelChoice,
  ModelOption,
  ModelPickerExtras,
  Msg,
  OsEditor,
  QuestionAsk,
  SlashItem,
  Thread,
  TranscriptNote,
  Work,
} from "../types";
import type { ThreadPark } from "../v3/v3-thread-menu";
import type { V3Status } from "../v3/v3-types";

/* The props the thread panel (ThreadView) and the session view (FocusView)
   take identically — one declaration, so the two frames can't drift: a
   composer prop either frame accepts, both accept (the widened session once
   lost the `@` and `/` menus and the attachment cap by being a second list).
   What only one frame needs stays in that frame's own props. D-#19: a control
   renders only when its handler is passed, so the app shows only working
   surfaces. */
export interface ThreadFrameProps {
  root: Extract<Msg, { kind: "msg" }>;
  thread: Thread;
  channel: Channel;
  /** The thread's employee: names the composer and resolves the session's
      model. Absent → the first employee who replied. */
  lead?: Employee;
  emp: EmpFn;
  human: HumanFn;
  resolved: Record<string, string>;
  setResolved?: (r: Record<string, string>) => void;
  /* The thread's one status word (client-runtime `threadStatus`, mapped to
     the shared vocabulary by the host) — the header's pill. Absent = no pill. */
  threadStatus?: V3Status;
  work: Work | null;
  onStart?: () => void;
  running: boolean;
  /* Return a promise to delay clearing the composer draft until it resolves;
     a rejected send keeps the text (issue #103, AC-5). */
  onSend: (text: string, files?: AttachedFile[]) => void | Promise<unknown>;
  onStop?: () => void;
  /* Host-held composer draft for this conversation (issue #103); omitted, the
     composer keeps its own state. */
  draft?: string;
  onDraftChange?: (v: string) => void;
  /* ↑ recall for the composer: the host's last sent message in this
     conversation (issue #104 AC-5). */
  lastSent?: string;
  /* Engine-reported models + pick handler (issue #30); no onModel → no picker (D-#19). */
  models?: ModelOption[];
  onModel?: (c: ModelChoice) => void;
  /* Refresh / Edit models… / provider names — each renders only with its handler. */
  picker?: ModelPickerExtras;
  /* The engine's `models.list.default` — the unpinned-employee pick (#92 AC-5). */
  defaultModel?: string;
  /* The default's provider — a `{provider?, id}` pair disambiguates a shared id. */
  defaultProvider?: string;
  onRetry?: (empId: string) => void;
  onUnqueue?: (i: number) => void;
  onSendQueued?: (i: number) => void;
  /* Messages sent while the turn runs that the agent hasn't read yet. They wait in the tray above the
     composer; `steer` (engine declared session.steer) only changes when they get read (issue #9).
     A `{text, removable}` row the engine already holds hides its Edit/Remove (#315). */
  pending?: QueuedTrayItem[];
  /* #557: the relay socket is down and the client is redialing — a thin
     "Reconnecting…" line over the composer; the send waits and lands once
     the socket is back. */
  reconnecting?: boolean;
  /* Composer attachment types the host accepts (e.g. "image/*"); absent = no attach UI. */
  accept?: string;
  /* Attachment byte cap + count cap + where rejections surface (issue #31). */
  maxFileSize?: number;
  maxFiles?: number;
  onAttachError?: (message: string) => void;
  steer?: boolean;
  /* #308: the running turn is engine-initiated (a leg) — Enter queues,
     and the composer names whose work it is instead of offering to
     steer. */
  agentWorking?: boolean;
  onRemovePending?: (i: number) => void;
  /* A note on the transcript's state — the kind picks the slot (#532):
     "trimmed" heads the transcript (#431 — history missing above the
     first entry); "unavailable" tails it (#28 — the live tail can't
     replay). */
  transcriptNote?: TranscriptNote;
  /* os.editors result: the folder badge gains an "Open in …/Reveal in
     Finder" menu only when the frame also has an os.open (issue #110,
     D-#19). */
  editors?: OsEditor[];
  /* `@` menu sections (#105): employees for mention; a file/dir search for
     the Files section — passed only when the session has a folder (cwd). */
  mentionables?: Employee[];
  onSearchFiles?: (query: string) => Promise<FileMention[]>;
  /* The `/` menu's provider (engine commands + skills) and the host's claim
     hook for app-owned command sends; modelOpen controls the picker the
     `/model` send opens. */
  onSearchCommands?: (query: string) => Promise<SlashItem[]>;
  onCommand?: (name: string, args: string) => boolean;
  modelOpen?: boolean;
  onModelOpen?: (open: boolean) => void;
  /* A message id to bring into view — set when the user opens a search hit
     (issue #138 AC-3): scrolls the message center into view and flashes it
     briefly. Retried while replies stream in. */
  scrollTo?: string;
  /* Fired once the scroll happened; the host clears `scrollTo` there. */
  onScrolled?: () => void;
  /* #134 "Rewind to here" on every user row (root included): the host drops
     the message + everything after and restores the folder to the pre-turn
     checkpoint. Disabled while a turn runs (AC-5). */
  onRewind?: (messageId: string) => void;
  /* AC-5: when another session shares this folder a click must confirm first
     — the string names the sharer. */
  rewindWarning?: string;
  /* AC-4: rewound message images re-entering the composer — forwarded to the
     Composer's `seedFiles`. */
  seedFiles?: AttachedFile[];
  onSeededFiles?: () => void;
  /* A subagent row that is another employee links to their session (issue #170). */
  onOpenSession?: (employeeId: string, session: string) => void;
  /* #560: the meter's Compact now — passed only when the engine declares
     `compact`; disabled while a turn runs. Continue opens a fresh session
     on the same folder (offered only when the meter reads Full). */
  onCompact?: () => void;
  onContinue?: () => void;
  /* Plan card decisions (issue #175). */
  onPlan?: (a: PlanAction, planId: string) => void;
  /* #420: question-ask answer/cancel — passed, the handler owns the
     resolved write (the card locks as "Sending…" until it lands). */
  onAnswer?: (q: QuestionAsk, a: QuestionAnswer) => void;
  onCancel?: (q: QuestionAsk) => void;
  /* #106: the thread's access level + toggle → the composer pill.
     Both or neither (D-#19: no access record, no control). */
  access?: ConversationAccess;
  onAccess?: (a: ConversationAccess) => void;
  /* Rename the title in place / put the thread away (true) or back (false):
     the header's ⋯ menu draws the items whose handler is passed, none → no
     menu. `thread.archived` says which way Settle reads (the wire still
     says archived until the backend slice renames it, #862). `park`
     carries the menu's pin / snooze / auto-settle choices the app backs. */
  onRename?: (title: string) => void;
  onArchive?: (archived: boolean) => void;
  park?: ThreadPark;
  /* #554: the host's wired find bar, rendered as an overlay inside the
     conversation scrollport (desktop ⌘F); absent = no find UI. */
  findBar?: ReactNode;
}
