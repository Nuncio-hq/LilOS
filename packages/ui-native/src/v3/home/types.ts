import type { Person } from "../types";

/* View models Home and Pulse take as props. */

/** The latest update, as a line from whoever wrote it. */
export type HomeUpdate = {
  by: Person;
  /** "11:20" — when it was written. */
  at: string;
  text: string;
};

export type HomeCountKey = "working" | "needs" | "stuck";
export type HomeCounts = Record<HomeCountKey, number>;
