# LilOS — Agent Guide

Every coding agent follows this file. `CLAUDE.md` is a symlink to it; edit
`AGENTS.md`, never the link.

**Read `docs/index.html` first.** It is the one document: what LilOS is, the
AI-company direction, the repo map and stack, how the pieces fit, how work
happens (issues, verify tiers, the 7 steps), every decision in force
(`#d-<issue>` anchors) and the runbooks. Open it in a browser or read the
source; read only the sections you need.

## Hard rules

- **Product.** A Slack-style CompanyOS whose employees are AI agents. The
  engine owns sessions, memory, skills and profiles; LilOS owns only company,
  channels, messages, tickets and employee records. Stage: prototype —
  `prototype/` is the UI source of truth; UI lands in `packages/ui`
  (`ui-native` for mobile) in the prototype first.
- **Oscar is the client.** He accepts or rejects the product he can try, not
  diffs. "Done" means he can try it without reading code, with evidence. He
  chats in Vietnamese; everything in the repo is English.
- **Issues are the source of truth** (`Nuncio-hq/LilOS`, `gh`). Labels:
  `agent-ready`, `later`, `needs-human`. Take open `agent-ready` slices with
  no open PR; open a draft PR with `Closes #N` early; one slice at a time;
  one `Status` comment edited in place; DCO sign-off (`git commit -s`).
- **Verify.** Pick a tier (Small / Prototype / Normal) and state it in the
  PR; when unsure, Normal. Normal = `bun run verify`, one screenshot per
  acceptance criterion, a fresh-context review, then a hand-off note Oscar
  can act on. The engine/protocol seam is always Normal.
- **Structure.** `apps/*` → `packages/*`, never back; engine packages depend
  only on `contracts`; boundary types live only in `packages/contracts`;
  Bun-only APIs only at app entry points; CI never calls a real LLM.
- **Agent tools.** Every feature ships its tools in
  `packages/contracts/src/harness/tools.ts`, or lists the method in
  `NOT_AGENT_FACING` with a reason. Company changes are `approval` tools;
  scope comes from the session, never an agent-passed id.
- **Decisions** are real only with an issue and a merged PR. Record them in
  the decisions section of `docs/index.html` in the same PR that implements
  them; say what was rejected (`Not:`).
- **Docs.** Two documents: this file and `docs/index.html`. No new Markdown
  docs; plans, logs and research go in issues/PRs. A PR that makes
  `docs/index.html` wrong fixes it in the same PR.
