import type { V3Attachment, V3Step, V3Ticket } from "@lilos/ui/v3-data";

/* The demo queue: what the company brings up next, for the notification demo.
   Every item names real agents, projects and goals of the seed company. */

/** A new thing waiting on you: its ticket, the thread where the agent asked,
    and the ask itself, laid out like HB-11 / a-1. */
export type AskItem = {
  /** The ask's id, and the thread's: fixed so a replay after a reset matches. */
  id: string;
  threadId: string;
  from: string;
  projectId: string;
  goalId?: string;
  /** The ticket's title (it gets the project's next number). */
  ticket: string;
  title: string;
  ask: string;
  why: string;
  ifYes: string;
  ifNo: string;
  fallback: { at: string; does: string };
  /** Dollars the agent wants to spend; the agent's own budget fills in the rest. */
  spend?: number;
  /** Minutes the agent has been on it. */
  minutes: number;
  done: { text: string; took: string }[];
  todo: string[];
  /** What the CEO asked for, and the agent's report back. */
  brief: string;
  work: V3Step[];
  report: string;
  quote: string;
  attachments?: V3Attachment[];
  result?: V3Ticket["result"];
};

/** A CEO update, and the tickets it says are finished. */
export type UpdateItem = {
  id: string;
  text: string;
  ticketId?: string;
  finishes?: string[];
};

export const ASK_ITEMS: AskItem[] = [
  {
    id: "a-q1",
    threadId: "t-q1",
    from: "designer",
    projectId: "qrit",
    goalId: "g-qr",
    ticket: "Publish the QRit launch screenshots",
    title: "Publish the QRit launch screenshots",
    ask: "Publish the 5 launch screenshots to the QRit App Store listing.",
    why: "They are the last piece of the listing and the Pro tier ships Wednesday. Publishing is public, so I am asking first.",
    ifYes:
      "The screenshots go live on the listing within the hour. Designer moves on to the onboarding copy.",
    ifNo: "The screenshots stay as drafts and the listing keeps the old ones until you say go.",
    fallback: { at: "18:00", does: "keeps them as drafts" },
    minutes: 22,
    done: [
      { text: "Export 5 screenshots", took: "14m" },
      { text: "Check them against the listing copy", took: "8m" },
    ],
    todo: ["Publish to the listing"],
    brief:
      "Get the launch screenshots ready to publish. Ask Oscar before anything goes public.",
    work: [
      { kind: "read", target: "listing/copy.md", meta: "5 captions" },
      { kind: "edit", target: "screenshots/", meta: "5 exported" },
      {
        kind: "think",
        target:
          "The captions match the screenshots in order; nothing says “QRit Pro” yet, which fits the open name question.",
      },
    ],
    report:
      "All five screenshots are exported and checked against the listing copy. Publishing is public, so I have asked Oscar to approve it. Nothing goes live until he does.",
    quote:
      "Wants to publish the 5 QRit launch screenshots to the App Store listing.",
    attachments: [{ kind: "image", label: "QRit launch screenshots · 5" }],
  },
  {
    id: "a-q2",
    threadId: "t-q2",
    from: "builder",
    projectId: "heardback",
    goalId: "g-hb",
    ticket: "Merge PR #66 behind the flag",
    title: "Merge PR #66 behind the flag",
    ask: "Merge PR #66 (paywall-copy-ab) into main behind the 50/50 flag.",
    why: "Reviewer checked both variants on device and the diff is clean. With the flag off, merging changes nothing for users.",
    ifYes:
      "PR #66 merges with the flag off. Builder turns it on for half of new users when you say so.",
    ifNo: "The PR stays open and the paywall test waits.",
    fallback: { at: "16:00", does: "leaves it open" },
    minutes: 9,
    done: [
      { text: "Rebase on main and rerun the tests", took: "7m" },
      { text: "Confirm the flag defaults to off", took: "2m" },
    ],
    todo: ["Merge and delete the branch"],
    brief:
      "PR #66 is signed off. Get it ready to merge, flag off, and ask Oscar first.",
    work: [
      { kind: "run", target: "git rebase origin/main", meta: "clean" },
      { kind: "run", target: "bun run test", meta: "all green" },
      { kind: "read", target: "src/paywall/flags.ts", meta: "default off" },
    ],
    report:
      "PR #66 is rebased, the tests are green and the flag defaults to off. Merging to main is your call, so I am asking before I do.",
    quote: "Wants to merge PR #66 into main behind the 50/50 flag.",
    attachments: [
      {
        kind: "pr",
        num: 66,
        title: "Paywall copy A/B test",
        branch: "paywall-copy-ab",
        add: 214,
        del: 38,
      },
    ],
    result: { pr: { num: 66, branch: "paywall-copy-ab", add: 214, del: 38 } },
  },
  {
    id: "a-q3",
    threadId: "t-q3",
    from: "marketer",
    projectId: "heardback",
    goalId: "g-hb",
    ticket: "Post the HeardBack thread on X",
    title: "Post the HeardBack thread on X",
    ask: "Post the 7-post HeardBack thread on X at 18:30 today.",
    why: "It uses the three best hooks from HB-9. Posting is public and cannot be unsent, so I am asking first.",
    ifYes:
      "The thread goes out at 18:30. Marketer reports the reach on Thursday.",
    ifNo: "The draft stays in drafts and Marketer rewrites it with your notes.",
    fallback: { at: "18:00", does: "keeps it as a draft" },
    minutes: 17,
    done: [
      { text: "Draft the 7 posts from the best hooks", took: "12m" },
      { text: "Check each claim against the sheet", took: "5m" },
    ],
    todo: ["Post at 18:30"],
    brief:
      "Turn the best hooks into a thread for X. Ask Oscar before anything is posted.",
    work: [
      { kind: "read", target: "hooks/scored.csv", meta: "50 rows" },
      { kind: "edit", target: "drafts/x-thread.md", add: 34, del: 0 },
      {
        kind: "think",
        target:
          "Lead with the hook readers scored highest; end on the one-line ask.",
      },
    ],
    report:
      "The thread is drafted: seven posts built on the hooks readers scored highest. Posting is public, so I have asked Oscar to approve it.",
    quote: "Wants to post the 7-post HeardBack thread on X at 18:30.",
  },
  {
    id: "a-q4",
    threadId: "t-q4",
    from: "scout",
    projectId: "heardback",
    goalId: "g-hb",
    ticket: "Export the creator contact list",
    title: "Approve $5 for a creator contact export",
    ask: "Spend $5 on a one-off export of public contact details for the 20 creators.",
    why: "The creators are vetted but the sheet has no way to reach them. The export is the cheapest way to fill it.",
    ifYes:
      "The export runs now and the contact column is filled within minutes.",
    ifNo: "Scout looks the contacts up by hand, about a day slower.",
    fallback: { at: "17:00", does: "denies it" },
    spend: 5,
    minutes: 11,
    done: [
      { text: "Vet the 20 creators", took: "9m" },
      { text: "Price the export", took: "2m" },
    ],
    todo: ["Run the export and fill the sheet"],
    brief:
      "Find a way to reach the 20 creators. Ask Oscar before anything costs money.",
    work: [
      { kind: "read", target: "creators.csv", meta: "20 rows" },
      { kind: "web", target: "export service · pricing", meta: "$5 one-off" },
    ],
    report:
      "The creators are vetted. A one-off contact export costs $5 and fills the whole column. I have asked Oscar to approve the spend.",
    quote: "Wants to spend $5 on a one-off export of creator contact details.",
    attachments: [{ kind: "sheet", name: "creators.csv", rows: 20 }],
  },
];

export const UPDATE_ITEMS: UpdateItem[] = [
  {
    id: "u-q1",
    text: "Paywall B is live for half of new users. Builder shipped it behind the flag and I will report the first numbers on Thursday.",
    ticketId: "HB-12",
    finishes: ["HB-12", "HB-13"],
  },
  {
    id: "u-q2",
    text: "Scout's creator sheet is done: 20 creators, each vetted with follower counts. Scout broke the search loop by switching to hashtag pages.",
    ticketId: "HB-14",
    finishes: ["HB-14"],
  },
  {
    id: "u-q3",
    text: "QRit Pro: Marketer has the listing copy ready under both names, so whichever you pick, the launch is covered.",
  },
];
