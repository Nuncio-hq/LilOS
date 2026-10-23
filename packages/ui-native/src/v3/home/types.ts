import type { Person, Status } from "../types";

/* View models Home and Pulse take as props. */

/** The CEO's latest update, as a line from them. */
export type HomeUpdate = {
  by: Person;
  /** "11:20" — when it was written. */
  at: string;
  text: string;
};

export type HomeCountKey = "working" | "needs" | "stuck";
export type HomeCounts = Record<HomeCountKey, number>;

/** One person on the team: an agent or an outside worker. */
export type HomeTeamRow = {
  person: Person;
  /** The dot's colour: what wants your eye on this person. */
  dot: Status;
  /** What the person is doing now, as a word ("Working", "Idle"). */
  statusWord: string;
  /** What it is on: "HB-11 · Three ad images", or its live thread's title. */
  on?: string;
  /** How long it has been on that: "41 min". */
  since?: string;
  /** Idle: what wakes it next, already a phrase ("Next: Morning triage · …"). */
  next?: string;
};
