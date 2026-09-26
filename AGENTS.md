# LilOS — Agent Guide

Every coding agent (Claude Code, Codex, Hermes, OpenCode, ...) follows this
file. `CLAUDE.md` is a symlink to it. Edit `AGENTS.md`, never the link.

## What LilOS is

A Slack-style "CompanyOS" where the employees are AI agents. One company
sidebar: company channels → projects (each with its own channels, e.g.
`#engineering` bound to a repo) → employees. An @mention or a DM opens a
thread, and each thread is one engine session. Engines plug in through a
generic engine protocol; Hermes is the first engine but is never glued in.
The engine owns sessions, memory, skills, and profiles. LilOS owns only its
own domain objects: company, channels, messages, tickets, employee records.

Stage: **prototype**. `prototype/` is the source of truth for UI/UX: the real
app must match it, and a UI/UX change lands in the prototype first. Its mock
data is not a contract.

## Repo map

| Path | What |
|---|---|
| `prototype/` | Live UX prototype: Vite 8 + React 19 + Tailwind v4 + shadcn (base-nova) + AI Elements. One `src/App.tsx` with mock data at the top. |
| `packages/contracts/` | Zod schemas for everything crossing a boundary (vitest tests in `test/`) |
| `e2e/` | Playwright E2E (screenshots to `test-results/`) |
| `docs/DECISIONS.md` | Decisions in force now (see Decisions) |
| `IDEA.md` | One-line origin note |

Prototype dev: `bunx vite prototype --port 5180` or
`bun run prototype:dev`. Verify everything: `bun run verify` (biome +
typecheck + vitest + prototype build + Playwright screenshot).
Setup once: `bun install` (Bun 1.4.2, see `.bun-version`).

## Stack & Structure

Runtime/PM **Bun** (workspaces; pinned `packageManager` + `.bun-version`);
server **Hono** on Bun; DB SQLite (`bun:sqlite`) via Drizzle; web React 19 +
Vite + Tailwind v4 + shadcn (base-nova) + AI Elements (mandatory) + TanStack
Router + nanostores; desktop Electron (later); lint/format Biome; tests
Vitest + Playwright; CI GitHub Actions (setup-bun) → `bun run verify`.

```
apps/web apps/relay apps/harness apps/desktop   (created by the slice that needs them)
packages/contracts packages/ui packages/client-runtime packages/engine-*
prototype/    packages/ui + mock data
```

- One-way deps: `apps/*` import `packages/*`, never the reverse. Engine
  packages depend only on `contracts`.
- The web app never talks to an engine directly; only through relay/harness.
- Types that cross a boundary are defined only in `packages/contracts`.
- Bun-only APIs (`bun:sqlite`, `Bun.serve`) only at app entry points;
  `packages/*` stay runtime-neutral.
- Organize code by feature folder; split a file past ~400 lines.
- `prototype/` is the UI source of truth: a UI/UX change lands there first,
  Oscar accepts, then it is implemented on `packages/ui`.
- Biome lints/forms everything except `prototype/src` and assets (vendored
  shadcn/AI Elements stay untouched; typecheck + build still cover them).
- CI never calls a real LLM; `engine-fake` is the deterministic engine.

## Learn from these projects

Before you design a seam, read how T3 Code (`pingdotgg/t3code`), Synara
(`Emanuele-web04/synara`), and Hermes Desktop (`NousResearch/hermes-agent`)
solve it — see `docs/REFERENCE-PROJECTS.md` for what to borrow and where to
start. All MIT: port ideas/code with an attribution comment. Don't port their
frameworks (T3/Synara use Effect-TS) or anything they own that we don't.
Cite the files you read in the issue.

## Who you work for

Oscar is the **client**, not a reviewer: he doesn't write code and rarely
reads diffs; he accepts or rejects the *product* he can see and try.

- You own correctness end to end: implementation, tests, review, and docs.
- "Done" means Oscar can try it without reading code, with evidence it works.
- Talk to him in plain product language: what changed, how to try it.
  Mention internals only when he must decide about them.
- Oscar chats in Vietnamese. Everything in the repo (code, docs, issues,
  PRs, commits) is in English.

## Work tracking: GitHub issues are the source of truth

Repo: `Nuncio-hq/LilOS`. Use the `gh` CLI.

- **Feature** = parent issue describing a product outcome; sub-issues are
  vertical slices.
- **What to work on next**: any open slice labelled `agent-ready` (has
  acceptance criteria + verify plan; if not, ask, don't take it). No priority
  order; finish slices inside a feature before starting a new one.
- **Now**: when you take a slice, label it `in-progress` and assign it. Hold
  one `in-progress` slice at a time. Keep **one** comment titled `Status` on
  the issue and edit it in place (Now / Next / Blocked); no log-comment series.
- **Done**: the slice closes with its merged PR (hand-off note there); when
  the last slice closes, close the feature.
- Found work outside the current slice? Open a new issue. Don't widen your PR.

## Verify loop

### Pick a tier yourself, and state it in the PR

| Tier | Examples | Steps |
|---|---|---|
| **Small** | typo, copy text, docs-only, comment, config that doesn't change behavior | Make the change → build if code was touched → PR with a one-line note. An issue is optional. |
| **Normal** | anything a user can see or any behavior change | All 7 steps below |

If you are unsure, pick **Normal**. Anything that touches the engine/protocol
seam (Hermes RPC, sessions, worktrees) is always Normal.

### The 7 steps (Normal tier)

1. **Understand**: read the issue. Acceptance criteria describe what a user
   sees ("open DM → send → reply shows in the thread"). Sharpen vague ones on
   the issue first; ask Oscar only when genuinely ambiguous.
2. **Plan**: write the plan in the issue's `Status` comment; split slices that
   are too big for one PR into more sub-issues.
3. **Implement**: tests with the code; show a failing test turning green.
4. **Verify**: run `bun run verify`; one screenshot per acceptance criterion.
5. **Review**: a second agent with fresh context reviews against the criteria
   (product behavior first, then code). Fix what it finds.
6. **Document**: fix docs the change makes stale; add/update the
   `docs/DECISIONS.md` entry for any architectural decision.
7. **Hand off**: a PR note Oscar can act on without reading code: how to try
   it, what changed, criteria checklist with screenshots, what's not done,
   `Closes #N`.

Oscar only does step 7: he tries the product and accepts it or sends it back.
A checklist of acceptance criteria plus screenshots is enough evidence for him.

## Decisions

**A decision is real only if it has an issue and a merged PR.** One agreed in
chat, a brainstorm, or an old doc without both was never implemented; don't
build on it — open an issue. Discussion, alternatives, and evidence live in
the **issue**; `docs/DECISIONS.md` is the **one** index of decisions in force
now, not a history log.

- Each entry is 1–3 lines, ID = issue number. Say what was rejected so nobody
  proposes it again:

  ```markdown
  ## Engine
  - **D-#12 Hermes owns sessions/transcripts; LilOS never stores them.**
    Not: own session DB (drift). — #12 · PR #15
  ```

- Group entries by area (`Engine`, `Data`, `Stack`, `UX`, ...); read that
  area's section before touching it.
- Add/change an entry only in the **same PR** that implements the decision.
  Proposed or undecided ideas stay in the issue.
- Record only decisions a later agent could undo by accident (architecture,
  protocol, data ownership, stack). Implementation choices inside one slice
  don't go in.
- Superseding: rewrite the entry in place, move the old choice to
  `Not: ... (was #old)`. Keep the file under ~4k characters.

## Docs

The repo keeps only knowledge that outlives a single issue; plans, progress,
logs, and research notes go in issues and PRs.

- Permanent docs: `AGENTS.md` (rules, auto-loaded), `docs/DECISIONS.md`
  (in force), and `docs/ARCHITECTURE.md` (how pieces fit; once real code
  exists outside `prototype/`). Read in that order, only as deep as needed;
  open an issue only when you need the *why*.
- Update an existing doc before creating one; create one only when two issues
  need the same knowledge. A PR that makes a doc wrong fixes it in the same
  PR; delete docs that are no longer true.
- Keep this file under ~8k characters; move detail out and link it.
