import type { Project, WorkspaceIntent } from "@lilos/contracts/app";
import { collapsePath, expandPath } from "@lilos/host";

/**
 * Filing a thread under a project (D-#854). The relay is the one place that
 * does it, so every client — the web app, the phone, an agent's
 * `thread_start` — sees the same filing without ever sending a project id:
 * they send the folder they mean (`cwd`) and the relay resolves it here.
 * Nothing here creates a project — the owner adds them by hand; a folder with
 * no project is a chat.
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
 * The project a folder files under (D-#854): the project whose folder IS it,
 * or the deepest project whose folder contains it — a repo's subfolders and
 * its `.lilos/wt/<slug>` worktrees belong to the repo's project. Stored
 * folders are already in the one canonical spelling, so containment is a
 * segment-boundary prefix compare. No match → undefined: a chat.
 */
export function projectForFolder(
  projects: readonly Project[],
  folder: string,
  home: string,
): Project | undefined {
  const want = projectFolderOf(folder, home);
  let best: Project | undefined;
  for (const project of projects) {
    if (best && project.folder.length <= best.folder.length) continue;
    if (want === project.folder || want.startsWith(`${project.folder}/`)) {
      best = project;
    }
  }
  return best;
}
