---
name: coding-cursor
description: "Hand a coding job to the Cursor agent CLI with defaults."
version: 1.0.0
author: LilOS
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Coding-Agent, Cursor, LilOS, Delegation]
    related_skills: [coding-claude, coding-devin, coding-antigravity]
---

# Hand off to Cursor (`cursor-agent`)

Delegate a coding job to the Cursor agent CLI in this thread's folder. The
run is non-interactive, and you verify the result yourself — never report
only the agent's self-report.

## When to Use

- The user asks you to hand, delegate, or pass a coding task to Cursor.
- Not for questions you can answer yourself, or when the user named a
  different agent (see `coding-claude`, `coding-devin`,
  `coding-antigravity`).

## Prerequisites

- `cursor-agent` on PATH and signed in (`cursor-agent --version` to check).
- This skill only works inside a LilOS session: `lilos_coding_agents` and
  `terminal` must exist.

## How to Run

1. **Read the user's stored default.** Call `lilos_coding_agents` and take
   `agents.cursor` (`model`, `effort`). An absent field means the CLI's own
   default — pass no flag for it.
2. **Apply a per-job override.** When the message overrides model or effort
   for this job, that value wins *for this job only* — do not store it.
3. **Only the user changes the default.** When the user asks to change the
   stored default itself, call `lilos_coding_agents_set` — it opens an
   approval card the user answers, then continue with the new value.
4. **Pick read-only or edit.** Questions, reviews, analysis, plans →
   read-only command. "Fix", "add", "change", "implement" → edit command.
   Default to read-only when unsure.
5. **Run it in this thread's folder** — pass the folder to `--workspace`
   AND as `terminal` `workdir`.
6. **Verify yourself** (below) and **report** in the format below.

## Model and effort flags

`cursor-agent` has no `--effort` flag — effort rides inside the model
string as a bracket override:

```
--model 'claude-opus-4-8[effort=high]'
```

- Model + effort both set → `--model 'M[effort=E]'`.
- Model only → `--model 'M'`.
- Effort only → append `[effort=E]` to the model you would run anyway.
- Neither → omit `--model`.

## Commands

Read-only — `--mode plan` (analyze/propose, no edits) or `--mode ask`
(pure Q&A):

```
terminal(command="cursor-agent -p '<PROMPT>' --workspace '<thread folder>' --trust --mode plan [--model '...'] --output-format json", workdir="<thread folder>", timeout=600)
```

Edit (the message asked for changes) — default agent mode, `--force` so
commands it needs don't stall print mode:

```
terminal(command="cursor-agent -p '<PROMPT>' --workspace '<thread folder>' --trust --force [--model '...'] --output-format json", workdir="<thread folder>", timeout=900)
```

- Quote the prompt with single quotes; escape an embedded `'` as `'\''`.
- JSON output carries the agent's final answer — quote that text, not the
  wrapper.

## Verify — yourself, not the agent

In the same `workdir`:

1. The exit status of the `terminal` run (non-zero = failed, report it).
2. `git status --porcelain` — quote the output. Not a git repo → say so.
3. `git diff --stat` for edit jobs — the files and churn that landed.
4. A check you ran when the job changed code or the message asked for one.
   Read-only jobs: "not run — read-only".

The agent's own claim of success is not verification.

## Report

```
<the agent's own answer>

Verified:
- command: <exact command as run>
- exit: <code>
- git status: <porcelain output or "clean">
- git diff: <stat output or "none">
- check: <command + result, or "not run — read-only job">
```

## Pitfalls

- Always pass `--print` (or `-p`) — interactive mode stalls the turn.
- Keep `--trust` so the workspace prompt can't stall the run.
- A per-job override is never stored; a stored default is never changed
  without `lilos_coding_agents_set` and the user's approval.
