---
name: coding-claude
description: "Hand a coding job to Claude Code with the user's defaults."
version: 1.0.0
author: LilOS
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Coding-Agent, Claude, LilOS, Delegation]
    related_skills: [coding-cursor, coding-devin, coding-antigravity]
---

# Hand off to Claude Code (`claude`)

Delegate a coding job to the Claude Code CLI in this thread's folder. The
run is non-interactive, and you verify the result yourself — never report
only the agent's self-report.

## When to Use

- The user asks you to hand, delegate, or pass a coding task to Claude Code
  or "claude".
- Not for questions you can answer yourself, or when the user named a
  different agent (see `coding-cursor`, `coding-devin`,
  `coding-antigravity`).

## Prerequisites

- `claude` on PATH and signed in (`claude --version` to check).
- This skill only works inside a LilOS session: `lilos_coding_agents` and
  `terminal` must exist.

## How to Run

1. **Read the user's stored default.** Call `lilos_coding_agents` and take
   `agents.claude` (`model`, `effort`). An absent field means the CLI's own
   default — pass no flag for it.
2. **Apply a per-job override.** When the message overrides model or effort
   for this job ("use high effort for this one"), that value wins *for this
   job only* — do not store it. Effort values: `low`, `medium`, `high`,
   `xhigh`, `max`.
3. **Only the user changes the default.** When the user asks to change the
   stored default itself ("make opus my default for Claude"), call
   `lilos_coding_agents_set` — it opens an approval card the user answers,
   then continue with the new value.
4. **Pick read-only or edit.** Questions, reviews, analysis, plans →
   read-only command. "Fix", "add", "change", "implement", "refactor" →
   edit command. Default to read-only when unsure.
5. **Run it in this thread's folder** via `terminal` — pass the folder as
   `workdir` explicitly (it is already the session's folder).
6. **Verify yourself** (below) and **report** in the format below.

## Commands

Read-only (analysis, review, Q&A — no edits possible):

```
terminal(command="claude -p '<PROMPT>' [--model M] [--effort E] --allowedTools 'Read,Glob,Grep' --max-turns 8 --output-format json", workdir="<thread folder>", timeout=600)
```

Edit (the message asked for changes):

```
terminal(command="claude -p '<PROMPT>' [--model M] [--effort E] --allowedTools 'Read,Glob,Grep,Edit,Write,NotebookEdit,Bash' --max-turns 25 --output-format json", workdir="<thread folder>", timeout=900)
```

- Omit `[--model M]` / `[--effort E]` when no stored or overridden value
  exists — never invent one.
- Quote the prompt with single quotes; escape an embedded `'` as `'\''`.
- `--output-format json` returns `{result, session_id, num_turns,
  total_cost_usd, subtype}` — `subtype` other than `success` means the run
  failed or hit a limit; say so.
- When a Bash-heavy edit is refused by `allowedTools`, narrow `Bash` to the
  patterns the task needs (e.g. `Bash(npm test *)`) rather than dropping it.

## Verify — yourself, not the agent

In the same `workdir`:

1. The exit status of the `terminal` run (non-zero = failed, report it).
2. `git status --porcelain` — quote the output (`clean` or the changed
   paths). Not a git repo → say "not a git repo".
3. `git diff --stat` for edit jobs — the files and churn that landed.
4. A check you ran: the project's test/build command when the job changed
   code or the message asked for one. Read-only jobs: "not run — read-only".

The agent's own claim of success is not verification.

## Report

```
<the agent's own answer — the `result` text from the JSON>

Verified:
- command: <exact command as run>
- exit: <code>
- git status: <porcelain output or "clean">
- git diff: <stat output or "none">
- check: <command + result, or "not run — read-only job">
```

## Pitfalls

- Never run `claude` without `-p` — interactive mode stalls the turn.
- Never add `--dangerously-skip-permissions`; the `allowedTools` list is the
  safety boundary.
- A per-job override is never stored; a stored default is never changed
  without `lilos_coding_agents_set` and the user's approval.
