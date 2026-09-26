# Decisions in force

Index of decisions that are in force now — not a history log. Rules for
entries live in `AGENTS.md` (Decisions). One agreed without an issue + merged
PR does not exist.

## Stack
- **D-#3 Bun is the runtime + package manager** (workspaces, pinned
  `packageManager` + `.bun-version`); Biome for lint/format; Vitest (unit) +
  Playwright (E2E/screenshots) behind one `bun run verify`.
  Not: pnpm/Node, ESLint + Prettier, per-package ad-hoc scripts. — #3 · PR #TBD
- **D-#3 Server: Hono on Bun (HTTP + WS).** Not: raw `Bun.serve` or Elysia —
  a benchmark (in #3) showed the framework is not the bottleneck; Elysia is
  Bun-locked. — #3 · PR #TBD
- **D-#3 DB: SQLite via `bun:sqlite` + Drizzle; Postgres later through the
  same Drizzle schema.** Not: raw SQL, or Postgres now. — #3 · PR #TBD
- **D-#3 Bun-only APIs (`bun:sqlite`, `Bun.serve`) only at app entry points;
  `packages/*` stay runtime-neutral.** Not: Bun APIs everywhere. — #3 · PR #TBD

## Web
- **D-#3 Web: React 19 + Vite + Tailwind v4 + shadcn (base-nova) + AI
  Elements (mandatory) + TanStack Router + nanostores.**
  Not: Next.js. — #3 · PR #TBD
- **D-#3 `prototype/` is the UI source of truth** (= future `packages/ui` +
  mock data); a UI/UX change lands in a prototype PR first, Oscar accepts,
  then it is implemented. Not: hand-copied UI in the web app. — #3 · PR #TBD

## Desktop
- **D-#3 Desktop: Electron (later slice).** Chromium parity with web;
  Playwright can drive it on macOS. Not: Tauri (WKWebView drift, no macOS
  WebDriver). — #3 · PR #TBD

## Testing
- **D-#3 CI (GitHub Actions, setup-bun) runs `bun run verify` with
  `engine-fake`; never a real LLM.** Not: real LLM in CI. — #3 · PR #TBD
- **D-#3 Local verify uses a real LLM via Hermes (HPC `qwen3.8-flash-next`
  local / `openai-codex` cloud); hand-offs state which was used; if both
  fail, tell Oscar.** Not: silently falling back to mock. — #3 · PR #TBD

## Structure
- **D-#3 One-way deps: `apps/*` → `packages/*`, never back; engine packages
  depend only on `contracts`.** Types crossing a boundary live only in
  `packages/contracts` (Zod). Not: Hermes-specific types in app code.
  The engine seam design itself is #5, not decided here. — #3 · PR #TBD
