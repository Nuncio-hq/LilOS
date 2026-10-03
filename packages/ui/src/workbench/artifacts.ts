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

/* The footer's "N files changed" — unique paths across the turn's diffs
   (issue #416). */
export function turnChangedFiles(r: Reply): Set<string> {
  return new Set(
    turnSteps(r)
      .filter((s) => s.diff)
      .map((s) => s.diff!.path),
  );
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
