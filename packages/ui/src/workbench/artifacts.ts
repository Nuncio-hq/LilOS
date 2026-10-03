import type { Diff, Reply, Step, Thread } from "../types";

/* Everything the workbench shows is derived from the session's tool calls — one source, no app state:
   inline_diff → Changes (merged per file), terminal output → Terminal, git commit → Commits.
   A subagent works in the same checkout, so its steps count too; another employee's help does
   not — that ran in their own session (issue #170). */
export function turnSteps(r: Reply): Step[] {
  return [
    ...(r.steps ?? []),
    ...(r.subagents ?? []).flatMap((a) => (a.employee ? [] : a.steps)),
  ];
}

/* ── "N files changed" (issue #416) ─────────────────────────────────────── */

/** Tools whose args name the workspace files they write — the same names
    Hermes, ACP agents and the fake engine carry. */
const FILE_WRITE_TOOLS = new Set(["write_file", "patch"]);

/** V4A multi-file patch headers — `*** Add|Update|Delete|Move File: <path>`
    inside a `patch` call's `patch` arg (no `path` arg in that mode). */
const V4A_FILE = /\*\*\* (?:Add|Update|Delete|Move) File: (.+)/g;

const normPath = (p: string) => p.trim().replace(/^\.\//, "");

/* What a completed file-write call touched, read from its own args — the
   count's ground truth when no diff was emitted (ACP tool_call_update
   carries none) or the diff's path is a placeholder. A denied/failed write
   changed nothing, so its args stay out. */
function inputPaths(s: Step): string[] {
  if (!FILE_WRITE_TOOLS.has(s.tool)) return [];
  if (s.status !== undefined && s.status !== "completed") return [];
  const out: string[] = [];
  const p = s.input?.path;
  if (typeof p === "string" && p) out.push(normPath(p));
  const v = s.input?.patch;
  if (typeof v === "string")
    for (const m of v.matchAll(V4A_FILE)) out.push(normPath(m[1]));
  return out;
}

/* The files one step changed — the write call's own args first (it knows
   its target even without an inline diff), else its diff's path. */
function stepChangedPaths(s: Step): string[] {
  const paths = inputPaths(s);
  return paths.length ? paths : s.diff ? [s.diff.path] : [];
}

/* The footer's "N files changed" — unique files across the turn's steps;
   matches Workbench → Changes for edits, new files and deletions. */
export function turnChangedFiles(r: Reply): Set<string> {
  return new Set(turnSteps(r).flatMap(stepChangedPaths));
}
export function sessionArtifacts(thread: Thread) {
  const steps = thread.replies.flatMap(turnSteps);
  const diffs = new Map<string, Diff>();
  for (const s of steps) {
    if (!s.diff) continue;
    const p = diffs.get(s.diff.path);
    diffs.set(
      s.diff.path,
      p
        ? {
            ...s.diff,
            add: p.add + s.diff.add,
            del: p.del + s.diff.del,
            status: p.status === "added" ? "added" : s.diff.status,
            patch: `${p.patch}\n${s.diff.patch}`,
          }
        : s.diff,
    );
  }
  const term = steps.filter((s) => s.tool === "terminal");
  const termOut = term
    .map(
      (s) =>
        `\u001b[36m$ ${String(s.input.command ?? "")}\u001b[0m\n${s.output}${s.output ? "\n" : ""}`,
    )
    .join("\n");
  const commits = steps
    .filter((s) => s.commit)
    .map((s) => s.commit!)
    .reverse();
  const add = [...diffs.values()].reduce((n, d) => n + d.add, 0);
  const del = [...diffs.values()].reduce((n, d) => n + d.del, 0);
  return {
    diffs: [...diffs.values()],
    termOut,
    termRunning: term.some((s) => s.running),
    commits,
    add,
    del,
  };
}

export type TreeNode = {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
};
export function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const p of paths) {
    let n = root;
    p.split("/").forEach((part, i, a) => {
      const path = a.slice(0, i + 1).join("/");
      if (!n.children.has(part))
        n.children.set(part, { name: part, path, children: new Map() });
      n = n.children.get(part)!;
    });
  }
  return root;
}
