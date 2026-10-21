import type { Conversation, Project } from "@lilos/contracts/app";
import { folderLeaf } from "../dm-model";

/* The demo's stand-in for the relay's filing rule (D-#771): a thread lives
   in the project of the folder it works in — a workstream thread files
   under its repo (`workspace.repoPath`, its `cwd` is the worktree), any
   other under its `cwd` — and a folder used for the first time becomes a
   project. No folder = a plain chat. Same rule as the real relay, in
   memory, so the demo's rows read exactly like production. */

/** The folder a thread files under, or undefined for a plain chat. */
export function filingFolder(
  conv: Pick<Conversation, "cwd" | "workspace">,
): string | undefined {
  return conv.workspace?.repoPath ?? conv.cwd;
}

/** A short uppercase tag from the name ("LilOS" → "LIL"); a taken tag gets
    a number so keys stay unique. */
function keyFor(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 3)
      .toUpperCase() || "PRJ";
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}${n}`;
  return key;
}

/** The project for `folder` and whether this call made it. One project per
    folder: asking again answers the existing one, never a second. */
export function projectForFolder(
  projects: readonly Project[],
  folder: string,
  now: number,
  fields: { name?: string; about?: string } = {},
): { project: Project; created: boolean } {
  const found = projects.find((p) => p.folder === folder);
  if (found) return { project: found, created: false };
  const name = fields.name ?? folderLeaf(folder);
  const key = keyFor(name, new Set(projects.map((p) => p.key)));
  return {
    created: true,
    project: {
      id: `proj-${key.toLowerCase()}`,
      name,
      key,
      folder,
      about: fields.about ?? "",
      createdAt: now,
    },
  };
}
