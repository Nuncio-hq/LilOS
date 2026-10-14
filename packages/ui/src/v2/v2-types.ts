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
  engine: string;
  /** Not usable yet (shown greyed in the picker). */
  soon?: boolean;
};

export type V2Project = {
  id: string;
  name: string;
  /** Short folder label ("~/Desktop/Oscar/LilOS"); absent = No project. */
  path?: string;
};

export type V2Msg = {
  from: "you" | "agent";
  time: string;
  text: string;
  /** Steps the agent ran for this reply, as one summary line. */
  steps?: string;
};

export type V2Ask = {
  kind: "approval" | "question";
  text: string;
  /** Approval: the command or change to allow. */
  detail?: string;
  /** Question: answer choices. */
  options?: string[];
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
  messages: V2Msg[];
};

export const V2_ATTENTION: V2State[] = ["needs", "failed", "unseen"];
