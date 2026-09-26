## Status

**Now:** Spike built and measured — harness owns headless Chromium (CDP
`Page.startScreencast` + `Input.dispatch*`) and a PTY shell (`node-pty`), an MCP
stdio server exposes `browser.*`/`terminal.*`/`previews.*` tools, and a
Workbench-style viewer streams both live and lets a human click/type.
Screen recording done (`spikes/24-harness/assets/recording.mp4`).

**Next:** Verdict comment posted separately; throwaway branch
`spike/24-harness-browser-terminal` carries code + numbers + architecture note
(`spikes/24-harness/NOTES.md`) for issue #36 to implement.

**Blocked:** This session has no GitHub API/CLI auth (`gh` unauthenticated,
repo private, git proxy is git-protocol only) — issue label + comments can't be
posted from here; they ship as `ISSUE_STATUS.md` / `ISSUE_VERDICT.md` on the
spike branch for the orchestrator to paste.
