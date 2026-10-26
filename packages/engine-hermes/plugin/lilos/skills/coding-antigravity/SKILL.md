---
name: coding-antigravity
description: "Hand a coding job to Antigravity's agy CLI with defaults."
version: 1.0.0
author: LilOS
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Coding-Agent, Antigravity, LilOS, Delegation]
    related_skills: [coding-claude, coding-cursor, coding-devin]
---

# Hand off to Antigravity (`agy`)

Delegate a coding job to the Antigravity CLI in this thread's folder. The
run is non-interactive, and you verify the result yourself — never report
only the agent's self-report.

## When to Use

- The user asks you to hand, delegate, or pass a coding task to
  Antigravity or "agy".
- Not for questions you can answer yourself, or when the user named a
  different agent (see `coding-claude`, `coding-cursor`, `coding-devin`).

## Prerequisites

- `agy` on PATH and signed in (`agy --version` to check).
- This skill only works inside a LilOS session: `lilos_coding_agents` and
  `terminal` must exist.

## How to Run

1. **Read the user's stored default.** Call `lilos_coding_agents` and take
   `agents.antigravity` (`model`, `effort`). An absent field means the
   CLI's own default — pass no flag for it.
2. **Apply a per-job override.** When the message overrides model or effort
   for this job, that value wins *for this job only* — do not store it.
   Effort values: `low`, `medium`, `high`, `xhigh`, `max`.
3. **Only the user changes the default.** When the user asks to change the
   stored default itself, call `lilos_coding_agents_set` — it opens an
   approval card the user answers, then continue with the new value.
4. **Pick read-only or edit.** Questions, reviews, analysis, plans →
   read-only. "Fix", "add", "change", "implement" → edit. Default to
   read-only when unsure.
5. **Run it in this thread's folder** via `terminal` with the folder as
   `workdir`.
6. **Verify yourself** (below) and **report** in the format below.

## Commands

Read-only — `--mode plan` analyzes and proposes without editing:

```
terminal(command="agy -p '<PROMPT>' [--model M] [--effort E] --mode plan --output-format json", workdir="<thread folder>", timeout=600)
```

Edit (the message asked for changes) — `--mode auto` runs the tools it
needs without prompting:

```
terminal(command="agy -p '<PROMPT>' [--model M] [--effort E] --mode auto --output-format json", workdir="<thread folder>", timeout=900)
```

- Omit `[--model M]` / `[--effort E]` when no stored or overridden value
  exists — never invent one.
- Quote the prompt with single quotes; escape an embedded `'` as `'\''`.
- JSON output carries the agent's final answer — quote that text.
- `--sandbox` is an optional extra boundary for untrusted trees; it is not
  required.

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

- Never run `agy` without `-p`/`--print` — interactive mode stalls the turn.
- Never use `--dangerously-skip-permissions`; `--mode` is the boundary.
- A per-job override is never stored; a stored default is never changed
  without `lilos_coding_agents_set` and the user's approval.
