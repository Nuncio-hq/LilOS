# Contributing to LilOS

Thanks for contributing! A few things to know before you open a pull request.

## Picking work

Issues are the source of truth. Look for the `agent-ready` label — those
slices have acceptance criteria and a verify plan. `later` issues are parked;
`needs-human` issues wait on a human decision. Read `AGENTS.md` first — it is
the repo's rule book (structure, verify loop, decisions log).

## Sign-off (DCO) — required on every commit

LilOS uses the **Developer Certificate of Origin**. Sign off every commit:

```bash
git commit -s
```

This adds a `Signed-off-by: Your Name <you@example.com>` trailer, certifying
that you wrote the change or otherwise have the right to submit it. CI checks
every commit on a pull request — unsigned commits fail the DCO check. Bot
commits (including `devin-ai-integration`) need sign-off too.

## Contribution terms (inbound grant)

By submitting a pull request you:

1. certify the DCO for each commit you sign off; and
2. license your contribution to Nuncio under the Elastic License 2.0 and
   grant Nuncio the right to relicense it — including under different terms
   in the future (for example if Nuncio ever offers LilOS as a service).

If you do not want to grant that, please don't open the PR.

## Local development

```bash
bun install
bun run verify   # biome + typecheck + unit tests + prototype build + Playwright e2e
```

The web prototype (`bun run prototype:dev`) is the UI/UX source of truth — a
UI change lands there first.

## Pull requests

- One change per PR; reference the issue (`Closes #N`).
- Keep everything in English — code, docs, issues, commits.
- Never commit secrets; CI runs `bun run verify` and a DCO check. Open the PR
  as a draft while you iterate: drafts run only the fast checks, and E2E runs
  once the PR is marked ready for review.
- Report security issues privately — see `SECURITY.md`.
