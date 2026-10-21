import type { Project, WorkspaceIntent } from "@lilos/contracts/app";
import { collapsePath, expandPath } from "@lilos/host";
import type { RelayStore } from "./store";

/**
 * Filing a thread under a project (D-#771). The relay is the one place that
 * does it, so every client — the web app, the phone, an agent's
 * `thread_start` — sees the same projects without ever sending a project id:
 * they send the folder they mean (`cwd`) and the relay resolves it here.
 */
/**
 * The ONE spelling a project's folder is stored and compared in: the
 * `~`-collapsed form every recents writer already uses (`collapsePath`, as
 * in the harness's move and `folders.add` for a phone), no trailing slash.
 * A project pick sends `cwd: project.folder`, so the relay's recents bump
 * lands on the existing row and the UI's folder lookup
 * (`recents.find(f => f.path === project.folder)`) hits — a second spelling
 * would list the repo twice. Matching is by this form: `~/Code/LilOS`,
 * `/Users/x/Code/LilOS/` and the stored folder all name the same project.
 * Folders outside the home stay absolute.
 */
export function projectFolderOf(path: string, home: string): string {
  const abs = expandPath(path, home);
  return collapsePath(abs.length > 1 ? abs.replace(/\/+$/, "") : abs, home);
}

/**
 * Where a newly opened thread files: a workstream thread (#156) runs in a
 * `.lilos/wt/*` worktree, but it belongs to the folder the worktree came
 * from, so `workspace.repoPath` wins over `cwd`. No folder at all → a plain
 * chat (undefined).
 */
export function openFolderOf(
  thread: { cwd?: string; workspace?: WorkspaceIntent },
  home: string,
): string | undefined {
  const raw = thread.workspace?.repoPath ?? thread.cwd;
  return raw ? projectFolderOf(raw, home) : undefined;
}

/**
 * The boot backfill for installs upgrading from before projects: files every
 * conversation that has a folder but no project, exactly as an open would —
 * one project per distinct folder (created on first sight, stamped with its
 * oldest thread's date, so keys and order follow history), a workstream
 * thread under its repo folder. Folder-less conversations stay plain chats.
 * Idempotent: a filed conversation is skipped, so a second boot finds
 * nothing to do and a half-finished first boot resumes.
 */
export async function backfillProjects(
  store: RelayStore,
  home: string,
): Promise<{ filed: number; created: number }> {
  const byFolder = new Map<string, Project>();
  for (const project of await store.listProjects()) {
    byFolder.set(project.folder, project);
  }
  const before = byFolder.size;
  const filings: { conversationId: string; projectId: string }[] = [];
  // Oldest first (the store's order): the first thread into a folder names
  // and dates its project.
  for (const conversation of await store.listConversations({
    includeArchived: true,
  })) {
    if (conversation.projectId) continue;
    const folder = openFolderOf(conversation, home);
    if (!folder) continue;
    let project = byFolder.get(folder);
    if (!project) {
      project = (
        await store.ensureProject({
          folder,
          createdAt: conversation.createdAt,
        })
      ).project;
      byFolder.set(folder, project);
    }
    filings.push({ conversationId: conversation.id, projectId: project.id });
  }
  await store.setConversationProjects(filings);
  return { filed: filings.length, created: byFolder.size - before };
}
