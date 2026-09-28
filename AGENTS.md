# LilOS — Agent Guide

Every coding agent follows this file. `CLAUDE.md` is a symlink to it;
edit `AGENTS.md`, never the link.

## What LilOS is

A Slack-style "CompanyOS" where the employees are AI agents. One sidebar:
company channels → projects (each with channels, e.g. `#engineering` bound
to a repo) → employees. An @mention or DM opens a thread = one engine
session. Engines plug in through a generic engine protocol (Hermes first,
never glued in). The engine owns sessions, memory, skills, profiles; LilOS
owns only its domain objects: company, channels, messages, tickets,
employee records.

Stage: **prototype**. `prototype/` is the UI/UX source of truth: a UI change
lands in `packages/ui` (`ui-native` for mobile) in the prototype first.
Mock data is not a contract.

## Repo map

| Path | What |
|---|---|
| `prototype/web`, `prototype/mobile` | UX prototypes (UI source of truth): mock data + fake engine/Mac + wiring in `src/App.tsx` |
| `packages/ui/` | `@lilos/ui`: every UI component (shadcn, AI Elements, LilOS surfaces); props in, callbacks out |
| `packages/contracts/` | Zod schemas for everything crossing a boundary |
| `packages/host/` | `@lilos/host`: fs + git reads on the session machine, served by the harness (runtime-neutral) |
| `e2e/` | Playwright E2E |
| `docs/DECISIONS.md` | Decisions in force now (see Decisions) |
| `IDEA.md` | One-line origin note |

Setup: `bun install` (Bun per `.bun-version`). Prototype: `bun run
prototype:dev`. Verify all: `bun run verify` (biome, typecheck, vitest,
prototype build, e2e).

## Stack & Structure

Runtime/PM **Bun** (workspaces; pinned `packageManager` + `.bun-version`);
server **Hono** on Bun; DB SQLite (`bun:sqlite`) via Drizzle; web React 19 +
Vite + Tailwind v4 + shadcn (base-nova) + AI Elements (mandatory) + TanStack
Router + nanostores; desktop Electron (later); lint/format Biome; tests
Vitest + Playwright; CI GitHub Actions → `bun run verify`.

```
apps/web apps/relay apps/harness apps/desktop   (created by the slice needing them)
packages/contracts packages/ui packages/client-runtime packages/host packages/engine-*
prototype/web prototype/mobile   packages/ui(-native) + mock data
```

- One-way deps: `apps/*` import `packages/*`, never the reverse. Engine
  packages depend only on `contracts`.
- The web app never talks to an engine directly; only through relay/harness.
- Types that cross a boundary are defined only in `packages/contracts`.
- Bun-only APIs (`bun:sqlite`, `Bun.serve`) only at app entry points;
  `packages/*` stay runtime-neutral.
- Organize code by feature folder; split a file past ~400 lines.
- Biome lints/formats all but `prototype/web/src`, `site/`, assets, and
  vendored shadcn/AI Elements in `packages/ui` (typecheck + build still
  cover them).
- CI never calls a real LLM; `engine-fake` is the deterministic engine.

## Learn from these projects

Before you design a seam, read how these solve it and cite the files in the
issue. All MIT: port ideas/code with an attribution comment, never their
frameworks (T3/Synara use Effect-TS).

| Project | Borrow | Start at |
|---|---|---|
| T3 Code `pingdotgg/t3code` | client/server split, seq sync (snapshot + replay), provider adapter + capabilities, `contracts`/`client-runtime` split | `docs/internals/`, `packages/contracts/src/providerRuntime.ts`, `apps/server/src/provider/Services/ProviderAdapter.ts` |
| Synara `Emanuele-web04/synara` | ACP adapter, adapter conformance tests, mock agents | `apps/server/src/provider/acp/`, `apps/server/src/provider/providerAdapterConformance.ts`, `apps/server/scripts/acp-mock-agent.ts` |
| Hermes Desktop `NousResearch/hermes-agent` | renderer over a headless engine, JSON-RPC client with reconnect replay, wire contract declared once and generated for TS | `apps/shared/src/json-rpc-gateway.ts`, `tui_gateway/contracts/`, `scripts/gen_gateway_contracts.py` |

## Who you work for

Oscar is the **client**, not a reviewer: he doesn't write code and rarely
reads diffs; he accepts or rejects the *product* he can see and try.

- You own correctness end to end: implementation, tests, review, docs.
- "Done" means Oscar can try it without reading code, with evidence it works.
- Talk to him in plain product language: what changed, how to try it.
- Oscar chats in Vietnamese. Everything in the repo (code, docs, issues,
  PRs, commits) is in English.

## Work tracking: GitHub issues are the source of truth

Repo: `Nuncio-hq/LilOS`. Use the `gh` CLI.

- **Feature** = parent issue describing a product outcome; sub-issues are
  vertical slices.
- **Labels** (only these): `agent-ready` (acceptance criteria + verify
  plan; any agent may take it), `later` (parked; don't take it),
  `needs-human` (blocked on Oscar: decision or local test).
- **What to work on next**: open `agent-ready` slices with no open PR
  (`label:agent-ready -linked:pr`). No priority order; finish slices inside
  a feature before starting a new one.
- **Now**: when you take a slice, remove `agent-ready`, assign it, and open
  a PR with `Closes #N` early. One slice at a time. Stuck → `needs-human`.
  Keep **one** comment titled `Status` on the issue and edit it in place
  (Now / Next / Blocked); no log-comment series.
  Commits need DCO sign-off (`git commit -s`, bots too).
- **Done**: the slice closes with its merged PR (hand-off note there); when
  the last slice closes, close the feature.
- Work outside the slice? Open a new issue; don't widen your PR.

## Verify loop

### Pick a tier yourself, and state it in the PR

| Tier | Examples | Steps |
|---|---|---|
| **Small** | typo, copy text, docs-only, comment, config that doesn't change behavior | Make the change → build if code was touched → PR with a one-line note. An issue is optional. |
| **Prototype** | UX in `prototype/*` + the `ui`/`ui-native` parts it shows, mock data | Issue → build → typecheck + lint → look at it (browser/simulator) → PR with screenshots. No tests, no `verify`: it only has to look right; tests come with the real implementation. |
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

Oscar only does step 7: he tries it and accepts or sends it back. A criteria
checklist plus screenshots is enough evidence.

## Decisions

**A decision is real only if it has an issue and a merged PR.** One agreed in
chat, a brainstorm, or an old doc without both was never implemented; don't
build on it — open an issue. Discussion and evidence live in the **issue**;
`docs/DECISIONS.md` is the **one** index of decisions in force, not a
history log.

- Each entry is 1–3 lines, ID = issue number, e.g. `- **D-#12 Hermes owns
  sessions/transcripts.** Not: own session DB (drift). — #12 · PR #15`.
  Say what was rejected so nobody proposes it again.

- Group entries by area (`Engine`, `Data`, `Stack`, `UX`, ...); read that
  area's section before touching it.
- Add/change an entry only in the **same PR** that implements the decision.
  Proposed or undecided ideas stay in the issue.
- Record only decisions a later agent could undo by accident (architecture,
  protocol, data ownership, stack), not choices inside one slice.
- Superseding: rewrite the entry in place, move the old choice to
  `Not: ... (was #old)`. Keep the file under ~4k characters.

## Docs

The repo keeps only knowledge that outlives an issue; plans, logs and
research notes go in issues/PRs.

- Permanent docs: `AGENTS.md` (rules, auto-loaded), `docs/DECISIONS.md`
  (in force), and `docs/ARCHITECTURE.md` (how pieces fit; once real code
  exists outside `prototype/`). Read in that order, only as deep as needed;
  open an issue only when you need the *why*.
- Update an existing doc before creating one; create one only when two issues
  need the same knowledge. A PR that makes a doc wrong fixes it in the same
  PR; delete docs that are no longer true.
- Keep this file under ~8.5k characters; move detail out and link it.
