# LilOS — Agent Guide

Every coding agent (Claude Code, Codex, Hermes, OpenCode, ...) follows this
file. `CLAUDE.md` is a symlink to it. Edit `AGENTS.md`, never the link.

## What LilOS is

A Slack-style "CompanyOS" where the employees are AI agents running on the
Hermes harness. One company sidebar: company channels → projects (each with its
own channels, e.g. `#engineering` bound to a repo) → employees. An @mention or a
DM opens a thread, and each thread is one Hermes session. Hermes owns sessions,
memory, skills, and profiles. LilOS only owns its own domain objects: company,
channels, messages, tickets, and employee records.

Stage: **prototype**. The product direction is still being brainstormed and is
not locked. Don't treat the prototype's mock data as a contract.

## Repo map

| Path | What |
|---|---|
| `prototype/` | Live UX prototype: Vite 8 + React 19 + Tailwind v4 + shadcn (base-nova) + AI Elements. One `src/App.tsx` with mock data at the top. |
| `docs/DECISIONS.md` | Decisions in force now (see Decisions). Created with the first decision. |
| `IDEA.md` | One-line origin note |

Run the prototype: `cd prototype && npm install && npx vite --port 5180`.
Check it: `cd prototype && npm run build` (runs `tsc -b` and `vite build`; it must pass).

## Who you work for

Oscar is the **client**, not a reviewer. He doesn't write code and rarely reads
diffs. He accepts or rejects the *product* that he can see and try. That means:

- You own correctness end to end: implementation, tests, review, and docs.
- "Done" means Oscar can try it without reading code, and you have shown
  evidence that it works.
- Talk to him in plain product language: what changed for the user, and how to
  try it. Mention internals only when he has to make a decision about them.
- Oscar chats in Vietnamese. Everything in the repo (code, docs, issues,
  PRs, commits) is in English.

## Work tracking: GitHub issues are the source of truth

Repo: `Nuncio-hq/LilOS`. Use the `gh` CLI.

- **Feature** = a parent issue that describes the product outcome. Its
  sub-issues are vertical slices.
- **What to work on next**: any open slice labelled `agent-ready`. There is no
  priority order. Features give the grouping, and you finish slices inside a
  feature before you start a new feature. `agent-ready` means the issue has
  acceptance criteria and a verify plan. If it lacks them, it is not ready.
  Don't take it. Ask instead.
- **Now**: when you take a slice, label it `in-progress` and assign it. Hold
  one `in-progress` slice at a time. Keep **one** comment titled `Status` on the
  issue and edit it in place (Now / Next / Blocked). Don't post a series of
  log comments.
- **Done**: the slice is closed by its merged PR, and the hand-off note is on
  that PR. When the last slice closes, close the feature.
- Found work outside the current slice? Open a new issue for it. Don't widen
  your PR.

## Verify loop

### Pick a tier yourself, and state it in the PR

| Tier | Examples | Steps |
|---|---|---|
| **Small** | typo, copy text, docs-only, comment, config that doesn't change behavior | Make the change → build if code was touched → PR with a one-line note. An issue is optional. |
| **Normal** | anything a user can see or any behavior change | All 7 steps below |

If you are unsure, pick **Normal**. Anything that touches the engine/protocol
seam (Hermes RPC, sessions, worktrees) is always Normal.

### The 7 steps (Normal tier)

1. **Understand**: read the issue. Its acceptance criteria describe what a
   user sees ("open DM → send → reply shows in the right-hand thread"). If they
   are vague, sharpen them on the issue first. Ask Oscar only when the ask is
   genuinely ambiguous.
2. **Plan**: write the plan in the issue's `Status` comment. If the slice is
   too big for one PR, split it into more sub-issues.
3. **Implement**: tests with the code; show a failing test turning green.
4. **Verify**: run the repo's verify command and capture one screenshot per
   acceptance criterion. Until `npm run verify` exists, use `npm run build`
   plus screenshots of the running prototype.
5. **Review**: a second agent with fresh context reviews against the
   acceptance criteria (product behavior first, then code). Fix what it finds.
6. **Document**: update the docs the change makes stale, and add/update the
   `docs/DECISIONS.md` entry if you made an architectural decision (see
   Decisions and Docs).
7. **Hand off**: a PR note Oscar can act on without reading code: how to try
   it, what changed, the checklist of criteria with screenshots, what is not
   done yet, and `Closes #N`.

Oscar only does step 7: he tries the product and accepts it or sends it back.
A checklist of acceptance criteria plus screenshots is enough evidence for him.

## Decisions

**A decision is real only if it has an issue and a merged PR.** A decision
without both was never implemented and does not exist in the app. That holds
even if it was agreed in chat, in a brainstorm, or in an old doc. Don't build
on it. Open an issue for it.

- The discussion, the alternatives, and the evidence live in the **issue**.
- `docs/DECISIONS.md` is the **one** index of decisions that are in force now.
  It is not a history log. The history and the reasons stay in the linked
  issue/PR. Create the file with the first decision.
- Each entry is 1–3 lines. The ID is the issue number. Say what was rejected,
  so nobody proposes it again:

  ```markdown
  ## Engine
  - **D-#12 Hermes owns sessions/transcripts; LilOS never stores them.**
    Not: own session DB (drift). — #12 · PR #15
  ```

- Group entries by area (`Engine`, `Data`, `Stack`, `UX`, ...). Before you
  touch an area, read that area's section.
- Add or change an entry only in the **same PR** that implements the decision.
  Proposed or undecided ideas never go in. They stay in the issue.
- Only record decisions that a later agent could otherwise undo by accident
  (architecture, protocol, data ownership, stack). Implementation choices
  inside one slice don't go in.
- Superseding a decision: rewrite the entry in place with the new issue/PR,
  and move the old choice to `Not: ... (was #old)`. Don't keep dead entries.
- Keep the file under ~4k characters. If it grows past that, the extra
  description belongs in `docs/ARCHITECTURE.md`.

## Docs

The repo keeps only knowledge that outlives a single issue. Everything else
(plans, progress, logs, research notes) goes in issues and PRs.

- The permanent docs are `AGENTS.md` (rules, auto-loaded), `docs/DECISIONS.md`
  (what's in force), and (once real code exists outside `prototype/`)
  `docs/ARCHITECTURE.md` (how the pieces fit). Read them in that order, and
  only as deep as the task needs. Open an issue only when you need the *why*.
- Update an existing doc before you create a new one. Create a new doc only
  when at least two issues need the same knowledge.
- A PR that makes a doc wrong fixes that doc in the same PR. Delete docs that
  are no longer true. Don't mark them deprecated.
- Keep this file under ~8k characters. If it grows, move detail into the doc it
  belongs to and leave a link here.
