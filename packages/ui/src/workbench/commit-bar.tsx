import {
  ArrowUpIcon,
  CircleAlertIcon,
  GitCommitHorizontalIcon,
  GitPullRequestIcon,
  LoaderCircleIcon,
  SparklesIcon,
} from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import type { ShipBar, ShipError, ShipHandlers } from "../types";

/* Commit → push → Create PR under the Changes file list (issue #107; the
   accepted #359 design). Presentational: state arrives on `bar`, every
   action is a handler; a missing handler hides its control (D-#19), and
   `isRepo:false` renders nothing (AC-6 — a non-repo folder has no bar). */

/* Plain copy per typed reason — raw stderr stays behind Details (#114 AC-5
   rule). Unknown reason → the thrown text. */
const COPY: Record<NonNullable<ShipError["reason"]>, string> = {
  rejected:
    "The remote has newer commits on this branch — update your checkout (git pull) and push again.",
  "no-remote":
    "This folder has no remote named “origin”. Add one — git remote add origin <url> — and try again.",
  auth: "Git couldn't sign in to the remote. Check your SSH key or credential helper, then push again.",
  conflict:
    "The repo has unmerged paths — finish the merge in a terminal first.",
  nothing: "Nothing to commit — the selected files have no changes.",
  exists: "A branch with that name already exists — pick another name.",
  unauthenticated:
    "GitHub CLI isn't signed in — run `gh auth login`, then try again.",
  missing: "GitHub CLI isn't installed — install `gh` to create pull requests.",
  other: "",
};

function shipText(error: ShipError): string {
  const known = error.reason && COPY[error.reason];
  return known || error.text || "Something went wrong.";
}

function prPrefill(commits: ShipBar["commits"]): {
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

export function CommitBar(props: ShipBar & ShipHandlers) {
  const {
    isRepo,
    branch,
    defaultBranch,
    files,
    commits,
    message,
    busy,
    error,
    running,
    accessory,
    onMessage,
    onSuggest,
    onCommit,
    onPush,
    onCreatePr,
  } = props;
  const [prOpen, setPrOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [newBranch, setNewBranch] = useState("");

  if (!isRepo) return null;

  const checked = files.filter((f) => f.checked);
  const onDefault =
    branch != null && defaultBranch != null && branch === defaultBranch;
  const busyWith = busy !== null;

  const openPrForm = () => {
    const p = prPrefill(commits);
    setTitle(p.title);
    setBody(p.body);
    setNewBranch("");
    setPrOpen(true);
  };

  const submitPr = () => {
    if (!onCreatePr || !title.trim()) return;
    void onCreatePr({
      title: title.trim(),
      body,
      ...(onDefault ? { branch: newBranch.trim() } : {}),
    })
      /* Success → the form folds; a rejection already surfaced as the bar's
         error, so keep the draft open for a retry. */
      .then(() => setPrOpen(false))
      .catch(() => {});
  };

  /* Busy labels + disabling per in-flight action. */
  const busyLabel =
    busy === "commit"
      ? "Committing…"
      : busy === "push"
        ? "Pushing…"
        : busy === "pr"
          ? "Opening PR…"
          : null;

  return (
    <div data-shipbar className="shrink-0 border-t bg-background px-3 py-2">
      {/* header: what the bar acts on + host chrome slot */}
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <GitCommitHorizontalIcon className="size-3.5 shrink-0" />
        <span className="truncate">
          {branch ? (
            <>
              Ship to <span className="font-mono">⎇ {branch}</span>
            </>
          ) : (
            <>Detached HEAD — commit here at your own risk</>
          )}
        </span>
        {accessory}
      </div>

      {error && (
        <div
          data-shiperror
          className="mt-2 flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-destructive text-xs"
        >
          <CircleAlertIcon className="mt-px size-3.5 shrink-0" />
          <div className="min-w-0">
            <p>{shipText(error)}</p>
            {error.detail && (
              <details className="mt-0.5">
                <summary className="cursor-pointer text-muted-foreground">
                  Details
                </summary>
                <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[10px]">
                  {error.detail}
                </pre>
              </details>
            )}
          </div>
        </div>
      )}

      {prOpen && onCreatePr ? (
        <div className="mt-2 space-y-2">
          {onDefault && (
            <div>
              <label
                htmlFor="ship-branch"
                className="mb-1 block text-muted-foreground text-xs"
              >
                New branch — you're on the default branch ({defaultBranch}), so
                the PR opens from a new one
              </label>
              <Input
                id="ship-branch"
                data-shipbranch
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                placeholder="feat/my-change"
                className="font-mono"
                disabled={busyWith}
              />
            </div>
          )}
          <Input
            data-shiptitle
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="PR title"
            disabled={busyWith}
          />
          <Textarea
            data-shipbody
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="PR body"
            rows={4}
            disabled={busyWith}
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPrOpen(false)}
              disabled={busyWith}
            >
              Cancel
            </Button>
            <Button
              data-shipcreate
              size="sm"
              onClick={submitPr}
              disabled={
                busyWith || !title.trim() || (onDefault && !newBranch.trim())
              }
            >
              {busy === "pr" ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                <GitPullRequestIcon />
              )}
              {busyLabel ?? "Create pull request"}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* message row: Suggest posts a normal user message; the answer
              fills this box. Hidden while a turn runs (AC-2). */}
          <div className="mt-2 flex items-center gap-2">
            <Input
              data-shipmessage
              value={message}
              onChange={(e) => onMessage?.(e.target.value)}
              placeholder="Commit message"
              className="font-mono"
              disabled={busyWith}
            />
            {onSuggest && !running && (
              <Button
                variant="outline"
                size="sm"
                data-shipsuggest
                onClick={onSuggest}
                disabled={busyWith}
                title="Ask the agent for a one-line commit message"
              >
                <SparklesIcon />
                Suggest
              </Button>
            )}
          </div>
          <div className="mt-2 flex items-center justify-end gap-2">
            {onCommit && (
              <Button
                variant="outline"
                size="sm"
                data-shipcommit
                onClick={() =>
                  void onCommit(
                    checked.map((f) => f.path),
                    message,
                  )
                }
                disabled={busyWith || checked.length === 0 || !message.trim()}
              >
                {busy === "commit" ? (
                  <LoaderCircleIcon className="animate-spin" />
                ) : (
                  <GitCommitHorizontalIcon />
                )}
                {busy === "commit"
                  ? "Committing…"
                  : `Commit ${checked.length} ${
                      checked.length === 1 ? "file" : "files"
                    }`}
              </Button>
            )}
            {onPush && (
              <Button
                variant="outline"
                size="sm"
                data-shippush
                onClick={() => void onPush()}
                disabled={busyWith}
              >
                {busy === "push" ? (
                  <LoaderCircleIcon className="animate-spin" />
                ) : (
                  <ArrowUpIcon />
                )}
                {busy === "push" ? "Pushing…" : "Push"}
              </Button>
            )}
            {onCreatePr && (
              <Button
                size="sm"
                data-shippr
                onClick={openPrForm}
                disabled={busyWith}
              >
                <GitPullRequestIcon />
                Create PR
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
