/* UX v2 view models (prototype): threads grouped by project, the agent is a
   per-thread picker (a Hermes profile today), no DMs. Not wire types. */

export type V2State =
  /** Parked on an approval or a question. */
  | "needs"
  /** The last turn failed. */
  | "failed"
  /** Finished since you last looked. */
  | "unseen"
  /** A turn is running. */
  | "working"
  /** Quiet, seen. */
  | "idle"
  /** Hidden until a time. */
  | "snoozed"
  /** Out of the list: accepted, merged, or quiet for 3 days. */
  | "settled";

/** Who works a thread: a Hermes profile today; Claude Code, Codex, bots later. */
export type V2Agent = {
  id: string;
  name: string;
  role: string;
  runtime: import("./v2-runtime").V2Runtime;
  /** Default model for new threads. */
  model?: string;
  /** Skills installed on the profile. */
  skills?: number;
  /** Not usable yet (shown greyed in the picker). */
  soon?: boolean;
};

export type V2Project = {
  id: string;
  name: string;
  /** Short folder label ("~/Desktop/Oscar/LilOS"); absent = No project. */
  path?: string;
};

/** One tool call, shown the way a coding agent shows its work. */
export type V2Step = {
  kind: "read" | "edit" | "bash" | "search" | "web" | "task";
  /** File path, command, query or URL. */
  target: string;
  /** Lines added / removed (edits). */
  add?: number;
  del?: number;
  /** Short trailing fact: "exit 0", "12 matches", "3 results". */
  meta?: string;
  /** The call failed. */
  failed?: boolean;
};

/** A few diff lines from one changed file, for the end-of-turn card. */
export type V2DiffLine = { kind: "add" | "del" | "ctx"; text: string };

export type V2Msg = {
  from: "you" | "agent";
  time: string;
  text: string;
  /** The tool calls behind this reply, in order. */
  work?: V2Step[];
  /** Files this reply changed, with a short preview of the first one. */
  changes?: { path: string; add: number; del: number }[];
  preview?: { path: string; lines: V2DiffLine[] };
};

export type V2Ask = {
  kind: "approval" | "question";
  text: string;
  /** Approval: the command or change to allow. */
  detail?: string;
  /** Question: answer choices. */
  options?: string[];
};

/** The step a running thread is on, with the last lines of its output. */
export type V2Live = {
  step: V2Step;
  elapsed: string;
  tail?: string[];
};

export type V2Thread = {
  id: string;
  title: string;
  projectId: string;
  agentId: string;
  model: string;
  state: V2State;
  /** Minutes since the last activity. */
  ago: number;
  pinned?: boolean;
  /** One line under the title: the live step, the ask, the result. */
  line?: string;
  /** "Until Mon 9:00" for snoozed threads. */
  until?: string;
  ask?: V2Ask;
  live?: V2Live;
  messages: V2Msg[];
};

/** One line in the company activity feed. */
export type V2Activity = {
  id: string;
  agentId: string;
  /** "opened", "finished", "asked to run", "settled". */
  verb: string;
  /** What it acted on: "PR #747", "Fix the flaky ac-544 e2e test". */
  object: string;
  threadId?: string;
  projectId?: string;
  ago: number;
};

export const V2_ATTENTION: V2State[] = ["needs", "failed", "unseen"];
