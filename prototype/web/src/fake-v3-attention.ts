import type { V3Data } from "@lilos/ui/v3-data"

/* The threads that stop and look at you instead of finishing on their own, so
   the prototype shows every card the real thread view has:
   · a question the CEO asks before a rename (answer it on the card),
   · a turn that failed (Retry sends your message again),
   · a plan waiting for your OK (Approve, Change or Reject; the plan itself is
     in thread/mock-plans.ts). */
export const ATTENTION_THREADS: V3Data["threads"] = [
  {
    id: "t-qr3",
    ticketId: "QR-3",
    agentId: "ceo",
    title: "Rename the app to “QRit Pro”?",
    status: "needs",
    startedAt: "11:52",
    minutes: 12,
    step: 4,
    context: 9,
    model: "Opus 5.5 · High",
    folder: "~/Code/qrit",
    askId: "a-2",
    quote: "Asks whether the app’s name should change with the Pro tier.",
    turns: [
      {
        n: 1,
        from: "you at 11:52",
        took: "12m so far",
        prompt: { by: "you", at: "11:52", text: "Should the Pro tier rename the app? Check the App Store first." },
        summary: "“QRit Pro” is free in the App Store. The name is your call, so I’m asking before anything changes.",
        steps: [
          { kind: "web", target: "App Store · search “QRit Pro”", meta: "no listing" },
          { kind: "search", target: "QRit", meta: "9 matches in the launch copy" },
          { kind: "think", target: "One name is simpler to market; a new name signals the upgrade. It changes five screenshots either way." },
        ],
      },
    ],
  },
  {
    id: "t-chat-prs",
    projectId: "lilos",
    agentId: "builder",
    title: "Summarise yesterday’s PRs",
    status: "failed",
    startedAt: "11:48",
    minutes: 1,
    context: 6,
    model: "Opus 5.5 · High",
    folder: "~/Code/LilOS",
    summary: "GitHub isn’t signed in on this Mac, so I couldn’t read yesterday’s PRs. Sign in, then retry.",
    turns: [
      {
        n: 1,
        from: "you at 11:48",
        took: "40s",
        prompt: { by: "you", at: "11:48", text: "Summarise yesterday's PRs" },
        steps: [{ kind: "run", target: "gh pr list --state merged --search merged:>=2026-10-18", meta: "not signed in", failed: true }],
      },
    ],
  },
  {
    id: "t-chat-sidebar",
    projectId: "lilos",
    agentId: "builder",
    title: "Remember the sidebar width",
    status: "needs",
    startedAt: "11:57",
    minutes: 3,
    context: 12,
    model: "Opus 5.5 · High",
    folder: "~/Code/LilOS",
    askId: "a-3",
    quote: "Proposes a four-step plan before touching code.",
    turns: [
      {
        n: 1,
        from: "you at 11:57",
        took: "3m so far",
        prompt: { by: "you", at: "11:57", text: "Make the sidebar remember its width when I restart the app." },
        steps: [
          { kind: "search", target: "sidebarWidth", meta: "3 matches" },
          { kind: "read", target: "packages/ui/src/v3/v3-layout-prefs.ts", meta: "128 lines" },
          { kind: "read", target: "packages/ui/src/v3/v3-shell.tsx", meta: "395 lines" },
          { kind: "think", target: "The width is already saved with the other layout prefs; the shell only reads it after the first paint, so the sidebar jumps." },
        ],
        answer:
          "The width is saved already, but it is read after the first paint, so the sidebar opens at its default and then jumps. I’d restore it before the first paint.\n\nHere is the plan. Nothing is touched until you approve it.",
      },
    ],
  },
]

/* The plan is an ask on Needs, as in the app ("Review the plan"); deciding it
   anywhere settles the thread through the engine. */
export const ATTENTION_ASKS: V3Data["asks"] = [
  {
    id: "a-3",
    threadId: "t-chat-sidebar",
    from: "builder",
    kind: "approval",
    title: "Review the plan",
    waiting: 3,
    ask: "The plan is in the thread; open it to read it before you decide.",
  },
]
