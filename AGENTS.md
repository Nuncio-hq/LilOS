# LilOS — Agent Guide

Every coding agent follows this file. `CLAUDE.md` is a symlink to it; edit
`AGENTS.md`, never the link.

**Read `docs/index.html`, then the code.** The page is the one document: what
LilOS is, where it is going (UX v2, the AI company with always-on bots), the
repo map, how work happens, and one line per decision in force pointing at
the file that carries its details (comments tagged `D-#<issue>`). Read the
source or open it in a browser; read only the sections you need.

## Hard rules

- **Oscar is the client.** He accepts or rejects the product he can try, not
  diffs. "Done" means he can try it without reading code, with evidence. He
  chats in Vietnamese; everything in the repo is English.
- **Issues are the source of truth** (`Nuncio-hq/LilOS`, `gh`). Take open
  `agent-ready` slices with no open PR; draft PR with `Closes #N` early; one
  slice at a time; one `Status` comment edited in place; `git commit -s`.
- **Verify.** Pick a tier (Small / Prototype / Normal) and state it in the
  PR; unsure or touching the engine seam → Normal: `bun run verify`, one
  screenshot per criterion, a fresh-context review, a hand-off Oscar can act on.
- **UI** lands in `prototype/` (`packages/ui`, `ui-native`) first.
- **Structure.** `apps/*` → `packages/*`, never back; boundary types only in
  `packages/contracts`; Bun-only APIs only at app entry points; CI never
  calls a real LLM.
- **Agent tools.** A feature ships its tools in
  `packages/contracts/src/harness/tools.ts`, or lists the method in
  `NOT_AGENT_FACING` with a reason.
- **Docs.** The code is the documentation: the why goes in a comment where
  the rule lives. Only this file and `docs/index.html`; no new Markdown.
  A decision needs an issue + merged PR; record it as one line on the page,
  tag the code `D-#<issue>`, in the same PR. `bun run verify` checks this.
