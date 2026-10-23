import type { V3Data, V3Reply, V3Thread } from "@lilos/ui/v3-data"

/* The fake agent behind ?v3 chats. It picks a script by what the message is
   about, so a chat in the prototype reads like a real session: a few steps
   (one may stream command output), then an answer with the details. CI never
   calls a real model; this is the deterministic stand-in. */
export function v3Reply(text: string, thread: V3Thread, d: V3Data): V3Reply {
  const lower = text.toLowerCase()
  const agent = d.agents.find((a) => a.id === thread.agentId)?.name ?? "I"
  const folder = thread.folder

  if (/flak|test|fail|e2e/.test(lower)) {
    return {
      steps: [
        { kind: "search", target: "ac-544", meta: "6 matches" },
        { kind: "read", target: "e2e/ac-544-workbench-reopen.spec.ts", meta: "212 lines" },
        {
          kind: "run",
          target: "playwright test ac-544 --repeat-each=10",
          meta: "2 of 10 failed · 1m 40s",
          failed: true,
          output: [
            "✓ reopens the cached workbench (run 1)",
            "✓ AC-6 restores the scroll position (run 1)",
            "✓ reopens the cached workbench (run 2)",
            "✗ AC-6 restores the scroll position (run 2)",
            "    expected scrollTop 1840, got 0",
            "✓ reopens the cached workbench (run 3)",
            "8 passed, 2 failed",
          ],
        },
        { kind: "think", target: "Both failures land at scrollTop 0: the restore ran before the list painted." },
      ],
      answer:
        "It fails **2 of 10** runs, always on AC-6, always with the list at the top (`scrollTop 0` instead of `1,840`).\n\nThe restore runs when the cache hydrates, but the list paints one frame later. On a slow frame the restore hits an empty list. Waiting two animation frames before restoring fixes it in my local runs.\n\nBuilder is already on this as **LIL-81**; I can add these traces to that ticket if you want.",
      attachments: [
        {
          kind: "diff",
          path: "packages/ui/src/workbench/workbench.tsx",
          add: 3,
          del: 1,
          lines: [
            { kind: "del", text: "  if (cache.ready) restoreScroll(saved)" },
            { kind: "add", text: "  if (!cache.ready) return" },
            { kind: "add", text: "  requestAnimationFrame(() =>" },
            { kind: "add", text: "    requestAnimationFrame(() => restoreScroll(saved)))" },
          ],
        },
      ],
    }
  }

  if (/summar|\bprs?\b|yesterday|merged|shipped/.test(lower)) {
    return {
      steps: [
        {
          kind: "run",
          target: "gh pr list --state merged --search merged:>=2026-10-18",
          meta: "4 PRs",
          output: ["#64  docs: fold the docs into one page", "#65  fix(relay): retry push on 429", "#62  feat(ui): thread sidebar settles quiet threads", "#61  chore: bump Hermes to 0.14.2"],
        },
        { kind: "read", target: "PR #64 · description", meta: "1 file" },
        { kind: "read", target: "PR #62 · description", meta: "9 files" },
      ],
      answer:
        "Four PRs merged since yesterday:\n\n- **#64** Docs fold into one page (`docs/index.html`): one document instead of eleven.\n- **#65** The relay retries push notifications on `429` with backoff.\n- **#62** Quiet threads settle out of the sidebar after 3 days.\n- **#61** Hermes bumped to `0.14.2`.\n\nNothing user-facing broke; #62 is the one Oscar would notice.",
      attachments: [{ kind: "pr", num: 64, title: "Fold the docs into one page", branch: "docs/one-page", add: 310, del: 1240 }],
    }
  }

  if (/release notes|changelog|announce/.test(lower)) {
    return {
      steps: [
        { kind: "run", target: "git log v0.8.0..HEAD --oneline", meta: "37 commits", output: ["0968ce1d docs: modules on the board", "7e953087 docs: one lean page", "d98fb4fd feat(prototype): the AI company screen", "… 34 more"] },
        { kind: "read", target: "docs/index.html#direction", meta: "UX v2 · AI company" },
        { kind: "edit", target: "drafts/release-0.9.md", add: 24, del: 0 },
      ],
      answer:
        "## LilOS 0.9\n\n**A company you can see.** Every agent's work now lives in tickets you can open, with each hand-off and step on one page.\n\n- **Needs you** collects every approval in one place, with what happens if you say yes or no.\n- **Threads** show live sessions: the step running now and its output.\n- **Docs** are one page.\n\nDraft saved to `drafts/release-0.9.md`. Want it shorter for the App Store?",
    }
  }

  return {
    steps: [
      { kind: "search", target: text.split(/\s+/).slice(0, 3).join(" "), meta: "9 matches" },
      { kind: "read", target: `${folder}/README.md`, meta: "84 lines" },
      { kind: "think", target: "The question is about how this works today, not a change. Answer from the code, cite the files." },
      { kind: "read", target: `${folder}/docs/index.html`, meta: "1 section" },
    ],
    answer: `Here's what I found in \`${folder}\`.\n\nThe short answer: it works the way the decisions page describes, and the code matches it. The two files that matter are \`README.md\` (how to run it) and \`docs/index.html\` (why it's built this way).\n\n${agent === "I" ? "I" : `${agent} here: I`} can go deeper on any part, or make this a ticket if it needs a change.`,
  }
}
