import type { AskVM, Person, Status } from "../types";

/* View models of the thread screen. The app turns a thread of the company
   into these; nothing here knows where the data lives. */

export type StepKind =
  | "read"
  | "search"
  | "edit"
  | "run"
  | "web"
  | "think"
  | "delegate";

/** One thing the agent did while working. */
export type StepVM = {
  key: string;
  kind: StepKind;
  target: string;
  meta?: string;
  add?: number;
  del?: number;
  failed?: boolean;
  running?: boolean;
  /** Where it ran when not on this Mac: "Cloud · Linux". */
  where?: string;
};

export type DiffLineVM = {
  key: string;
  kind: "add" | "del" | "ctx";
  text: string;
};

/** What a reply carries besides prose. */
export type AttachmentVM =
  | {
      key: string;
      kind: "pr";
      num: number;
      title: string;
      branch: string;
      add: number;
      del: number;
    }
  | {
      key: string;
      kind: "diff";
      path: string;
      add: number;
      del: number;
      lines: DiffLineVM[];
    }
  | { key: string; kind: "image"; label: string }
  | { key: string; kind: "sheet"; name: string; rows: number };

/** The message that started a turn. */
export type PromptVM = {
  /** You wrote it: a bubble. Otherwise an agent asked: a quiet line. */
  fromYou: boolean;
  /** Who asked, as a name ("Chief"). */
  who: string;
  /** "11:52" */
  at: string;
  text: string;
  /** Names of the files that came with it. */
  files: string[];
};

/** One turn = the message in, the work it caused, the answer out. */
export type TurnVM = {
  /** Stable across re-renders so a turn keeps its open/closed fold. */
  key: string;
  prompt?: PromptVM;
  steps: StepVM[];
  /** "12m", "12m so far" */
  took?: string;
  /** The agent is working on this turn right now: its steps start open. */
  live: boolean;
  /** Markdown. Grows while `streaming`. */
  answer?: string;
  streaming: boolean;
  /** What a turn with no answer did, in one line. */
  summary?: string;
  attachments: AttachmentVM[];
  /** Messages sent while the turn ran; the agent reads them after the step. */
  queued: { key: string; at: string; text: string }[];
};

export type ThreadVM = {
  id: string;
  agent: Person;
  /** Ticket id, project name or "Chat". */
  tag: string;
  status: Status;
  statusWord: string;
  /** Oldest first, the way a chat reads. */
  turns: TurnVM[];
  /** The step running now, while the thread is working. */
  now?: { text: string; elapsed: string };
  stuck?: { what: string; detail: string[] };
  /** Why a failed thread failed. */
  failure?: string;
  /** The ask this thread is waiting on, still open. */
  ask?: AskVM;
};
