/**
 * Issue #37 — real-leg check against a real `gh` (no fake).
 *
 * Runs the forge host API against a real git checkout of a repo that `gh` is
 * authenticated to: forge.pr → forge.comment → forge.pr re-read (the comment
 * must show on the PR). Merge is intentionally NOT exercised — the orchestrator
 * confirmed comment-only on the real repo (no merge on Nuncio-hq/LilOS).
 *
 * Usage:  scripts/live/37-forge.sh [path-to-checkout] [pr-number]
 *
 *   path    any git checkout whose `gh` resolves a repo (default: cwd)
 *   number  PR to comment on (default: the checkout branch's own PR)
 *
 * Prints a PASS/FAIL summary; exits non-zero on failure.
 */
// Relative import: scripts/ is not a workspace dir, so @lilos/host does not
// resolve here — packages/host resolves its own @lilos/* deps internally.
import { callHost } from "../../packages/host/src/index";

const dir = process.argv[2] ?? process.cwd();
const num = process.argv[3] ? Number(process.argv[3]) : undefined;
const stamp = new Date().toISOString();
const body = `LilOS forge live-leg check (issue #37) — ${stamp}`;

const fail = (m: string): never => {
  console.error(`FAIL ${m}`);
  process.exit(1);
};
const ok = (m: string) => console.log(` ok  ${m}`);

type Pr = {
  number: number;
  url: string;
  title: string;
  state: string;
  base: string;
  head: string;
  mergeable: string;
  checks: { name: string; status: string }[];
  comments: { author: string; at: string; body: string }[];
};

console.log(`forge live leg · dir=${dir} pr=${num ?? "(branch's own)"}`);

const view = (await callHost("forge.pr", { path: dir, number: num })) as {
  root: string;
  branch: string | null;
  pr: Pr | null;
};
ok(`forge.pr root=${view.root} branch=${view.branch}`);
if (!view.pr)
  fail("no pull request found — check out the PR's branch or pass its number");
const pr = view.pr;
ok(
  `PR #${pr.number} "${pr.title}" state=${pr.state} base=${pr.base} head=${pr.head}`,
);
ok(`checks=${pr.checks.length} comments=${pr.comments.length}`);
if (pr.state !== "open")
  fail(`PR #${pr.number} is ${pr.state} — pick an open PR`);

const posted = (await callHost("forge.comment", {
  path: view.root,
  number: pr.number,
  body,
})) as { url: string };
ok(`forge.comment → ${posted.url}`);

const after = (await callHost("forge.pr", {
  path: view.root,
  number: pr.number,
})) as { pr: Pr | null };
const found = after.pr?.comments.find((c) => c.body === body);
if (!found) fail("re-read did not show the new comment");
ok(`re-read shows the comment by @${found?.author} at ${found?.at}`);

console.log(`\nPASS forge live leg: pr view → comment → re-read on ${pr.url}`);
