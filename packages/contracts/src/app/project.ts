import { z } from "zod";
import { Timestamp } from "./domain";

/**
 * Projects (D-#771): a project is a folder the company works in. A thread
 * lives in a project (`Conversation.projectId`) or is a plain chat — there
 * is no third home. The relay owns the records and is the only place that
 * files a thread (`conversations.open` / `conversations.moveFolder` with a
 * folder), creating the folder's project on first use, so every client sees
 * the same filing. Not: a client-side grouping by `cwd`, or a project per
 * thread.
 */

/** A short uppercase tag — "LIL" — unique across projects. */
export const ProjectKey = z.string().regex(/^[A-Z0-9]{1,8}$/);

export const Project = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Unique short tag, derived from the name by the relay. */
  key: ProjectKey,
  /** Unique: one project per folder. Stored in the `~`-collapsed spelling
      the recent-folders list uses (`~/Code/LilOS`; absolute only outside
      the Mac's home), so a project pick (`cwd: project.folder`) and the
      recents never list one repo twice. Any spelling sent is normalized. */
  folder: z.string().min(1),
  about: z.string(),
  createdAt: Timestamp,
});
export type Project = z.infer<typeof Project>;

/* ------------------------------- wire params ----------------------------- */

export const ProjectsListParams = z.object({}).strict();
export const ProjectsListResult = z.object({ projects: z.array(Project) });
export type ProjectsListResult = z.infer<typeof ProjectsListResult>;

/**
 * `name` defaults to the folder's basename. A folder that already has a
 * project answers that project (nothing is created or renamed), so a retry
 * and the first-use filing in `conversations.open` can never make two.
 */
export const ProjectsCreateParams = z.object({
  name: z.string().trim().min(1).optional(),
  folder: z.string().min(1),
  about: z.string().optional(),
});
export type ProjectsCreateParams = z.infer<typeof ProjectsCreateParams>;

export const ProjectResult = z.object({ project: Project });
export type ProjectResult = z.infer<typeof ProjectResult>;

/** Broadcast to every peer whenever a project appears (like
    `employee.upserted`) — including the one a first-use open creates. */
export const ProjectUpsertedEvent = z.object({ project: Project });
export type ProjectUpsertedEvent = z.infer<typeof ProjectUpsertedEvent>;
