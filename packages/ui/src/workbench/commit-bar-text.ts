import type { ShipBar, ShipError } from "../types";

/* What the commit bar says and prefills, as plain functions: the copy for a
   failed git/gh step, the one line a Suggest reply gives the commit box, and
   the PR title and body a branch's commits make. */

/* Plain copy per typed reason — raw stderr stays behind Details (#114 AC-5
   rule). Unknown reason → the thrown text. #579 AC-2: no copy may ask for
   a terminal command — each names a next step the user can take (a button
   on the bar, or asking the employee). */
const COPY: Record<
  NonNullable<ShipError["reason"]>,
  (who: string) => string
> = {
  rejected: () =>
    "The remote has newer commits on this branch — Pull to bring them in (or ask the agent to update), then Push again.",
  diverged: (who) =>
    `The branch and its upstream diverged — Pull can't fast-forward. Ask ${who} to update the branch, then try again.`,
  "no-remote": (who) =>
    `This folder isn't on GitHub yet. Ask ${who} to publish it.`,
  auth: (who) =>
    `Git couldn't sign in to the remote. Ask ${who} to fix the sign-in, then push again.`,
  conflict: (who) =>
    `The repo has unmerged paths. Ask ${who} to finish the merge, then try again.`,
  nothing: () => "Nothing to commit — the selected files have no changes.",
  exists: () => "A branch with that name already exists — pick another name.",
  unauthenticated: (who) =>
    `GitHub isn't signed in on this machine. Ask ${who} to sign in, then try again.`,
  missing: (who) =>
    `GitHub CLI isn't installed on this machine. Ask ${who} to install it, then try again.`,
  other: () => "",
};

export function shipText(error: ShipError, employeeName?: string): string {
  const known = error.reason && COPY[error.reason];
  const text = known ? known(employeeName ?? "the agent") : "";
  return text || error.text || "Something went wrong.";
}

/* #584: a Suggest answer is one full reply — the commit box takes its
   first real line, minus markdown dressing (a reply like "> feat: foo" or
   "`feat: foo`" must land usable). */
export function suggestLine(text: string): string {
  return (
    text
      .split("\n")
      .map((s) => s.trim().replace(/^>\s*/, "").replace(/^`|`$/g, "").trim())
      .find(Boolean) ?? ""
  );
}

export function prPrefill(commits: ShipBar["commits"]): {
  title: string;
  body: string;
} {
  const first = commits[0]?.message ?? "";
  const list = commits.map((c) => `- \`${c.hash}\` ${c.message}`).join("\n");
  return {
    title: first || "Update",
    body:
      "## Summary\n\n" +
      (first || "Updates from this branch.") +
      (list ? `\n\n## Commits\n\n${list}` : ""),
  };
}
