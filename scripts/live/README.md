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
