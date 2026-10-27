import type { PullRequest, Work } from "../types";

/* The quiet line that used to sit in the composer row while idle ("Edits go
   to ⎇ branch", "Read-only on main", …): where the next edit will land.
   #886 took it off the row — it was a label, not a control — and the
   header's folder kicker carries it as a tooltip instead. `session` picks
   the session view's wording where the two frames always differed. */
export function idleHint({
  work,
  repo,
  pr,
  isDM,
  session,
}: {
  work: Pick<Work, "branch"> | null;
  /** The channel's repo, when it has one (the panel). */
  repo?: string;
  pr?: Pick<PullRequest, "status" | "number" | "head">;
  isDM: boolean;
  session: boolean;
}): string | undefined {
  if (pr?.status === "merged")
    return `#${pr.number} merged, ⎇ ${pr.head} deleted · next edit starts a new branch from main`;
  if (work?.branch) return `Edits go to ⎇ ${work.branch}`;
  if (work)
    return session
      ? "Edits land in this folder"
      : "Ticket only. No repo on this channel.";
  if (isDM) return undefined;
  if (session) return "Read-only on main";
  return repo ? "Read-only on main. Start work to edit code." : undefined;
}
