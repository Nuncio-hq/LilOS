---
name: coding-devin
description: "Hand a coding job to the Devin CLI with stored defaults."
version: 1.0.0
author: LilOS
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Coding-Agent, Devin, LilOS, Delegation]
    related_skills: [coding-claude, coding-cursor, coding-antigravity]
---

# Hand off to Devin (`devin`)

Delegate a coding job to the Devin CLI in this thread's folder. The run is
non-interactive, and you verify the result yourself — never report only the
agent's self-report.

## When to Use

- The user asks you to hand, delegate, or pass a coding task to Devin.
- Not for questions you can answer yourself, or when the user named a
  different agent (see `coding-claude`, `coding-cursor`,
  `coding-antigravity`).

## Prerequisites

- `devin` on PATH and signed in (`devin version` to check).
- This skill only works inside a LilOS session: `lilos_coding_agents` and
  `terminal` must exist.

## How to Run

1. **Read the user's stored default.** Call `lilos_coding_agents` and take
   `agents.devin` (`model`, `effort`). An absent field means the CLI's own
   default.
2. **Apply a per-job override.** When the message overrides the model for
   this job, that value wins *for this job only* — do not store it.
3. **Only the user changes the default.** When the user asks to change the
   stored default itself, call `lilos_coding_agents_set` — it opens an
   approval card the user answers, then continue with the new value.
4. **Pick read-only or edit.** Questions, reviews, analysis → read-only.
   "Fix", "add", "change", "implement" → edit. Default to read-only.
5. **Run it in this thread's folder** via `terminal` with the folder as
   `workdir`.
6. **Verify yourself** (below) and **report** in the format below.

## Model and effort flags

- `--model <MODEL>` — pass it when a value is stored or overridden.
- **Effort:** `devin --help` shows no effort/thinking flag in print mode.
  A stored `effort` cannot be forwarded to this CLI — say so in the report
  ("stored effort not passed — the devin CLI takes no effort flag") rather
  than inventing a flag.

## Commands

Read-only — `--permission-mode auto` auto-approves read-only tools only:

```
terminal(command="devin -p '<PROMPT>' --permission-mode auto [--model M]", workdir="<thread folder>", timeout=600)
```

Edit (the message asked for changes):

```
terminal(command="devin -p '<PROMPT>' --permission-mode accept-edits [--model M]", workdir="<thread folder>", timeout=900)
```

- Quote the prompt with single quotes; escape an embedded `'` as `'\''`.
- If the run fails on workspace trust ("print mode cannot show the trust
  prompt"), retry once with `--respect-workspace-trust false`.
- Never use `--permission-mode dangerous`.

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

- Always pass `-p` — interactive mode stalls the turn.
- A per-job override is never stored; a stored default is never changed
  without `lilos_coding_agents_set` and the user's approval.
