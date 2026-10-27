import { z } from "zod";
import { Timestamp } from "./domain";

/**
 * Projects (D-#854): Oscar decides what a project is — one is made only by
 * hand (`projects.create`, the sidebar's + or a chat chip's Add as project),
 * never inferred from a folder being used. A thread files under the deepest
 * project whose folder equals or contains its folder (`Conversation.projectId`
 * — the relay writes it), or is a plain Chat with the folder still shown.
 * `projects.remove` takes only the record: the folder and every thread stay,
 * the threads become chats. Not: a project created on first use (D-#771's
 * old rule), a client-side grouping by `cwd`, or a project per thread.
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
 * `name` defaults to the folder's basename; `key` defaults to the derived
 * tag — the dialog prefills both and the user may edit them (#854). A folder
 * that already has a project answers that project (nothing is created or
 * renamed), so a retry can never make two.
 */
export const ProjectsCreateParams = z.object({
  name: z.string().trim().min(1).optional(),
  key: ProjectKey.optional(),
  folder: z.string().min(1),
  about: z.string().optional(),
});
export type ProjectsCreateParams = z.infer<typeof ProjectsCreateParams>;

export const ProjectResult = z.object({ project: Project });
export type ProjectResult = z.infer<typeof ProjectResult>;

/**
 * `projects.remove` (D-#854) — takes only the project record. Its threads
 * keep their folders and re-file by containment (another project may still
 * cover them; most become chats), its tickets and goals keep their records
 * without a project. Nothing on disk is touched.
 */
export const ProjectsRemoveParams = z.object({ id: z.string().min(1) });
export type ProjectsRemoveParams = z.infer<typeof ProjectsRemoveParams>;

/** Broadcast to every peer whenever a project appears (like
    `employee.upserted`). */
export const ProjectUpsertedEvent = z.object({ project: Project });
export type ProjectUpsertedEvent = z.infer<typeof ProjectUpsertedEvent>;

/** Broadcast on `projects.remove` so every client drops the record. */
export const ProjectRemovedEvent = z.object({
  projectId: z.string().min(1),
});
export type ProjectRemovedEvent = z.infer<typeof ProjectRemovedEvent>;
