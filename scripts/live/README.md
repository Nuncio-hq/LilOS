# scripts/live — one-off live checks

Small, issue-scoped scripts that run the real stack (real relay + harness,
`LILOS_ENGINE=hermes`, a real phone or the packaged app) when an issue's
acceptance criteria can't be proven by `bun run verify` alone. Their output
is evidence — it lands in the issue's PR, not in CI.

- Name a check after its issue: `<issue>.sh`, `<issue>.ts`, or
  `issue-<issue>.sh`. Keep it small — one issue, one check, no framework.
- When the issue closes the script is deleted from `main` and archived
  under an `archive/live-scripts-*` tag — restore one with
  `git show <tag>:scripts/live/<file>` (e.g. tag
  `archive/live-scripts-2026-10`, created in #443).
- `openai-stub.ts` is the shared OpenAI-compatible chat stub live checks
  spawn so `hermes serve` runs for real without a signed-in model.
- `scripts/live/lib/helpers.ts` is the shared plumbing every leg uses —
  `freePort`, `launch`, `waitForFile`, `cleanup`, `startStub`. New checks
  and the harness demo scripts (`apps/harness/scripts/*`) import it by
  relative path instead of pasting their own copies; it's covered by
  `bun run typecheck` (`scripts/live/tsconfig.json`).
- `scripts/live/lib/lilos-plugin.sh` is the shared `.sh` connect: a leg
  sourcing it runs `lilos_connect_plugin` (bundled plugin copied +
  `plugins enable` + tool-search off + `browser` toolset suppressed, the
  connect.ts sequence) on its scratch HERMES_HOME, then `lilos_clone_profile
  <name>` for each named profile the leg resolves — without it, sessions
  under a scratch home log `'lilos' is still not loaded` (#642).
