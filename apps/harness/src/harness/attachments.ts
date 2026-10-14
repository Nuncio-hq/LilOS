import { execFile } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

/**
 * Where non-image attachment bytes land so the agent reads them with its
 * normal file tools (images still ride the prompt as image blocks when
 * the engine declares `image_prompt`).
 *
 * Bound sessions decode into `<cwd>/.lilos/attachments/` — LilOS's own
 * in-folder namespace alongside `.lilos/wt` worktrees, already excluded
 * from folder checkpoints; a `.git/info/exclude` line keeps the folder's
 * real repo clean too. Folder-less sessions have no folder to write
 * into, so theirs go under the harness state dir — still a path the
 * agent's file tools can open.
 */

export const ATTACHMENT_DIR_NAME = join(".lilos", "attachments");

export function attachmentDir(
  cwd: string,
  hasFolder: boolean,
  stateDir: string,
): string {
  return hasFolder ? join(cwd, ATTACHMENT_DIR_NAME) : join(stateDir, "attachments");
}

/** Decode one attachment into the session's attachment dir; returns the
    absolute path. Names collide-suffix (`-1`, `-2`, …) so a resend or a
    same-name file never clobbers a file an earlier turn read. */
export function saveAttachment(opts: {
  cwd: string;
  hasFolder: boolean;
  stateDir: string;
  name: string;
  dataBase64: string;
}): { path: string } {
  const dir = attachmentDir(opts.cwd, opts.hasFolder, opts.stateDir);
  mkdirSync(dir, { recursive: true });
  const path = uniquePath(dir, safeName(opts.name));
  writeFileSync(path, Buffer.from(opts.dataBase64, "base64"));
  return { path };
}

/**
 * Keep `<cwd>/.lilos/attachments/` out of the folder's own git status:
 * one line in `info/exclude` (untracked metadata, unlike `.gitignore`
 * nothing lands in the user's diff). `--git-common-dir` resolves to the
 * shared git dir, so a session bound to a linked worktree covers the
 * worktree too. Best-effort — a non-repo or missing git skips it.
 */
export async function excludeFromGit(cwd: string): Promise<void> {
  const commonDir = await new Promise<string | undefined>((resolveP) => {
    execFile(
      "git",
      ["-C", cwd, "rev-parse", "--git-common-dir"],
      (err, stdout) => resolveP(err ? undefined : stdout.trim() || undefined),
    );
  });
  if (!commonDir) return;
  try {
    const exclude = join(resolve(cwd, commonDir), "info", "exclude");
    const line = `${ATTACHMENT_DIR_NAME}/`;
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (current.split("\n").includes(line)) return;
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, `${line}\n`);
  } catch {
    /* read-only git dir — the file still lands, it just shows as untracked */
  }
}

/* A base name the session folder can host — no path segments, no
   control chars, never empty/dot-only, bounded so the file list stays
   readable in the prompt. */
function safeName(raw: string): string {
  const cleaned = basename(raw)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping path-unfriendly control bytes is the point.
    .replace(/[\u0000-\u001f]/g, "_")
    .trim();
  const name = cleaned === "" || cleaned === "." || cleaned === ".." ? "attachment" : cleaned;
  return name.length > 100 ? name.slice(0, 100) : name;
}

function uniquePath(dir: string, name: string): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length) || "attachment";
  for (let i = 0; ; i++) {
    const candidate = join(dir, i === 0 ? name : `${stem}-${i}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
}

/** `1.2 MB`-style size for the prompt's file list. */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "? B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let size = bytes;
  let unit = "B";
  for (const u of units) {
    if (size < 1024) break;
    size /= 1024;
    unit = u;
  }
  return `${size >= 100 ? Math.round(size) : size.toFixed(1)} ${unit}`;
}
