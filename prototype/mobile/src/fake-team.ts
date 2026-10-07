import type {
  Approval,
  ChannelRow,
  EmployeeRow,
  FolderOption,
  ModelPick,
  ModelProviderRow,
  ModelRow,
  ProjectGroup,
  ThreadDetail,
  WorkspacePick,
} from "@lilos/ui-native";
import { atom } from "nanostores";

/* Fake team for the mobile prototype — the twin of the web prototype's
   EMPLOYEES/PROJECTS/DM_FEEDS mock (prototype/web/src/App.tsx). Mock data,
   not a contract: the relay will serve the real thing. */

export const EMPLOYEES: Omit<EmployeeRow, "state" | "now">[] = [
  {
    id: "builder",
    name: "Builder",
    role: "Engineer",
    tone: "blue",
    when: "now",
    ticket: "LIL-7",
  },
  {
    id: "reviewer",
    name: "Reviewer",
    role: "Code review",
    tone: "violet",
    when: "2m",
  },
  {
    id: "marketer",
    name: "Marketer",
    role: "Growth",
    tone: "sunset",
    when: "6m",
  },
  {
    id: "default",
    name: "Default",
    role: "Generalist",
    tone: "stone",
    when: "Mon",
  },
];

export const IDLE_NOW: Record<string, string> = {
  builder: "Wiring the relay handshake",
  reviewer: "Reviewed #93",
  marketer: "Drafted the launch thread",
  default: "Sorted your inbox",
};

export const COMPANY: ChannelRow[] = [
  { id: "general", name: "general" },
  { id: "announcements", name: "announcements", unread: 1 },
];

export const PROJECTS: ProjectGroup[] = [
  {
    id: "lilos",
    name: "LilOS",
    key: "LIL",
    channels: [
      { id: "lilos-eng", name: "engineering", activeTone: "blue" },
      { id: "lilos-design", name: "design", unread: 3 },
      { id: "lilos-marketing", name: "marketing" },
    ],
  },
  {
    id: "qrit",
    name: "QRit",
    key: "QR",
    channels: [{ id: "qrit-eng", name: "engineering", unread: 2 }],
  },
  {
    id: "gj",
    name: "Grocery Journal",
    key: "GJ",
    channels: [{ id: "gj-eng", name: "engineering" }],
  },
];

// ── Pickers (web: FOLDERS + MODELS) ─────────────────────────────────────────

const FOLDERS: FolderOption[] = [
  {
    id: "lilos",
    project: "LilOS",
    path: "~/Desktop/Oscar/LilOS",
    branches: ["main", "release/0.1"],
    workstreams: [
      { branch: "feat/relay-reconnect", path: ".lilos/wt/lil-9", from: "main" },
      { branch: "lil-3-monorepo", path: ".lilos/wt/lil-3", from: "main" },
    ],
  },
  {
    id: "qrit",
    project: "QRit",
    path: "~/Desktop/Oscar/SamProjects/QRit",
    branches: ["main", "develop"],
    workstreams: [
      { branch: "qr-7-paywall", path: ".lilos/wt/qr-7", from: "develop" },
    ],
  },
  {
    id: "notes",
    project: "Notes",
    path: "~/Documents/Notes",
    branches: [],
    workstreams: [],
  },
];

const LADDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const CODEX = ["low", "medium", "high", "xhigh", "max"];

export const MODELS: ModelRow[] = [
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    provider: "anthropic-cliproxy",
    efforts: LADDER,
    defaultEffort: "high",
    fast: true,
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    provider: "anthropic-cliproxy",
    efforts: LADDER,
    defaultEffort: "medium",
  },
  {
    id: "claude-3-5-haiku",
    name: "Claude 3.5 Haiku",
    provider: "anthropic-cliproxy",
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    provider: "openai-codex",
    efforts: CODEX,
    defaultEffort: "medium",
    fast: true,
  },
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    provider: "openai-codex",
    efforts: ["none", ...CODEX],
    defaultEffort: "low",
    fast: true,
  },
  {
    id: "grok-4.6",
    name: "Grok 4.6",
    provider: "xai-oauth",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    fast: true,
  },
  {
    id: "qwen3.8-flash-next",
    name: "Qwen 3.8 Flash-Next",
    provider: "hpc",
    efforts: LADDER,
    defaultEffort: "medium",
  },
];

/* Same providers as the web prototype (Oscar's real Hermes config); `logo`
   is the models.dev slug the logo is drawn from. */
export const PROVIDERS: ModelProviderRow[] = [
  { id: "hpc", name: "HPC", logo: "alibaba" },
  {
    id: "anthropic-cliproxy",
    name: "Anthropic – CLIProxyAPI",
    logo: "anthropic",
  },
  {
    id: "openai-codex",
    name: "ChatGPT or Codex Subscription",
    logo: "openai",
  },
  {
    id: "xai-oauth",
    name: "xAI Grok OAuth (SuperGrok / Premium+)",
    logo: "xai",
  },
];

/** The next DM session's pick: starts at the employee default (web rule). */
/** Folders sessions can run in; "Other folder on the Mac…" adds to it. */
export const $folders = atom<FolderOption[]>(FOLDERS);

export const $wsPick = atom<WorkspacePick>({
  folder: "lilos",
  base: "main",
  mode: "new",
});
export const $modelPick = atom<ModelPick>({
  model: "claude-opus-5-5",
  effort: "high",
});
/** Per-thread model picks (a thread keeps its own). */
export const $threadModel = atom<Record<string, ModelPick>>({});

// ── Approvals ───────────────────────────────────────────────────────────────

export const APPROVALS: Approval[] = [
  {
    id: "a-migrate",
    employeeId: "builder",
    employee: "Builder",
    tone: "blue",
    session: "Relay handshake",
    reason:
      "Needs to run the database migration before the relay tests can pass.",
    command: "bun run db:migrate --env dev",
    age: "4m",
  },
  {
    id: "a-flake",
    employeeId: "reviewer",
    employee: "Reviewer",
    tone: "violet",
    session: "ac-80 flake",
    reason: "Wants to re-run the flaky DM identity test 20× to prove the fix.",
    command: "bunx playwright test ac-80 --repeat-each 20",
    age: "2m",
  },
  {
    id: "a-post",
    employeeId: "marketer",
    employee: "Marketer",
    tone: "sunset",
    session: "Launch thread",
    reason: "Ready to post the launch thread on X.",
    file: { name: "launch-thread.md", detail: "6 posts · 2 images" },
    age: "1m",
  },
  {
    id: "q-base",
    employeeId: "reviewer",
    employee: "Reviewer",
    tone: "violet",
    session: "Where #96 lands",
    kind: "question",
    reason:
      "The release cut is Thursday. Do you want the replay fix on `release/0.1` too, or does it wait for the next train?",
    options: [
      {
        id: "cherry-pick",
        label: "Cherry-pick to `release/0.1`",
        description: "Opens a second PR against the release branch.",
      },
      {
        id: "next-train",
        label: "Keep it on main",
        description: "Ships with the next regular train, not the release.",
      },
      {
        id: "hold",
        label: "Hold the cherry-pick until after the cut",
        description: "Leaves `release/0.1` alone while the freeze is on.",
      },
    ],
    freeText: true,
    age: "now",
  },
];

// ── Builder's sessions (web: DM_FEEDS["dm-builder"]) ────────────────────────

export const BUILDER = {
  id: "builder",
  name: "Builder",
  tone: "blue" as const,
};
export const LILOS = { name: "LilOS", path: "~/Desktop/Oscar/LilOS" };

export const THREADS: ThreadDetail[] = [
  {
    id: "s-gap",
    title: "First harness connection",
    state: "done",
    employee: BUILDER,
    when: "Mon",
    started: "Mon 16:40",
    folder: LILOS,
    branch: { name: "main", detail: "read-only · no worktree" },
    model: "Claude Opus 5.5 · High",
    session: "ses_4a19",
    usage: "38.4k in · 2.9k out · 24k cached",
    /* #514: the engine's capped log dropped this session's head — the
       transcript note the real feed raises on historyTrimmed (#431). */
    transcriptNote:
      "Earlier history was trimmed — this session's event log is capped.",
    entries: [
      {
        kind: "user",
        id: "u1",
        time: "16:40",
        text: "What's left before the relay can accept its first harness connection?",
      },
      {
        kind: "agent",
        id: "g1",
        time: "16:41",
        thought: 6,
        reasoning:
          "Oscar asks for the gap list, not a build plan. No ticket, so read main only. Check the relay package and the contracts, list only what blocks one harness from connecting.",
        steps: [
          {
            id: "1",
            tool: "search_files",
            arg: "WebSocketServer in apps/relay",
            output: "0 matches",
          },
          {
            id: "2",
            tool: "read_file",
            arg: "packages/contracts/src/envelope.ts",
            output: "58 lines · seq, kind, body",
          },
          {
            id: "3",
            tool: "read_file",
            arg: "apps/relay/package.json",
            output: '{ "name": "@lilos/relay", "main": "src/index.ts" }',
          },
        ],
        text: "Three things block it:\n\n- **Relay has no socket yet.** `apps/relay` is an empty package.\n- **No auth handshake.** The envelope has `seq` but no member token.\n- **No harness package.** Nothing dials out yet.\n\nThe first two are one ticket. The third is its own.",
        footer: { dur: 34, model: "Opus 5.5", effort: "High" },
      },
      { kind: "user", id: "u2", time: "16:44", text: "Which one first?" },
      {
        kind: "agent",
        id: "g2",
        time: "16:44",
        thought: 2,
        reasoning: "Order by dependency: the harness needs something to dial.",
        text: "Relay socket + token check first. The harness has nothing to dial without it, and it's the smaller change (about 150 lines).",
        footer: { dur: 6, model: "Opus 5.5", effort: "High" },
      },
    ],
  },
  {
    id: "s-pair",
    title: "Pair phone dialog",
    state: "done",
    employee: BUILDER,
    when: "Yesterday",
    started: "Yesterday 17:02",
    folder: LILOS,
    branch: {
      name: "proto/pair-phone",
      detail: "new worktree off main · .lilos/wt/lil-8",
    },
    model: "Claude Opus 5.5 · High",
    session: "ses_9e27",
    usage: "71.2k in · 6.1k out · 52k cached",
    prs: [
      { number: 91, title: "Pair phone: QR + manual code", status: "merged" },
      { number: 93, title: "Pair phone: bigger mono code", status: "merged" },
      {
        number: 95,
        title: "Pair phone: copy tweaks",
        status: "open",
        checks: "passing",
      },
    ],
    entries: [
      {
        kind: "user",
        id: "u1",
        time: "17:02",
        text: "Add a Pair phone dialog on the Mac: QR, address and a one-time code.",
      },
      {
        kind: "agent",
        id: "g1",
        time: "17:09",
        thought: 4,
        reasoning:
          "Worktree off main, so I can edit. The dialog belongs in packages/ui (props in, callbacks out); the prototype only wires fake data. Code expires, so the dialog needs a countdown and a refresh.",
        steps: [
          {
            id: "1",
            tool: "read_file",
            arg: "packages/ui/src/dialogs/hire-dialog.tsx",
            output: "303 lines",
          },
          {
            id: "2",
            tool: "search_files",
            arg: "qrcode in packages/ui",
            output: "0 matches",
          },
          {
            id: "3",
            tool: "terminal",
            arg: "bun add qrcode.react --cwd packages/ui",
            output: "installed qrcode.react@4.2.0",
          },
          {
            id: "4",
            tool: "write_file",
            arg: "packages/ui/src/dialogs/pair-phone-dialog.tsx",
            output: "242 lines",
            add: 242,
            del: 0,
          },
          {
            id: "5",
            tool: "patch",
            arg: "prototype/web/src/App.tsx",
            output: "wire PairPhoneDialog to the Mac menu",
            add: 18,
            del: 4,
          },
          {
            id: "6",
            tool: "terminal",
            arg: "bun run verify",
            output:
              "biome   ✓ 212 files\ntsc     ✓\nvitest  ✓ 64 passed\nplaywright ✓ 31 passed (48.2s)",
          },
        ],
        text: "Done on `proto/pair-phone`. The dialog shows the **QR**, the Tailscale address and a 6-digit code that expires in 10 minutes, with a Refresh button.\n\n- Lives in `packages/ui`, props in, callbacks out.\n- Opens from the Mac menu → **Pair phone**.",
        footer: {
          dur: 412,
          model: "Opus 5.5",
          effort: "High",
          files: 2,
        },
      },
      {
        kind: "user",
        id: "u2",
        time: "17:20",
        text: "Make the code bigger and mono.",
      },
      {
        kind: "agent",
        id: "g2",
        time: "17:21",
        thought: 1,
        reasoning: "One class change on the code block.",
        steps: [
          {
            id: "1",
            tool: "patch",
            arg: "packages/ui/src/dialogs/pair-phone-dialog.tsx",
            output: "text-3xl font-mono tracking-[0.3em]",
            add: 1,
            del: 1,
          },
        ],
        text: "Bigger and mono now, with wider letter spacing so it reads aloud easily.",
        footer: { dur: 19, model: "Opus 5.5", effort: "High", files: 1 },
      },
    ],
  },
  {
    id: "s-relay",
    title: "Relay handshake",
    state: "working",
    employee: BUILDER,
    when: "now",
    started: "Today 09:12",
    folder: LILOS,
    branch: {
      name: "feat/relay-reconnect",
      detail: "new worktree off main · .lilos/wt/lil-9",
    },
    model: "Claude Opus 5.5 · High",
    session: "ses_b71d",
    usage: "44.9k in · 3.3k out · 31k cached",
    prs: [
      {
        number: 96,
        title: "Relay: replay the gap on reconnect",
        status: "draft",
        checks: "failing",
      },
    ],
    entries: [
      {
        kind: "user",
        id: "u1",
        time: "09:12",
        text: "Wire the relay handshake so the phone can reconnect after the Mac sleeps.",
      },
      {
        kind: "agent",
        id: "g1",
        time: "09:19",
        thought: 8,
        reasoning:
          "Events already carry seq. On reconnect the phone sends afterSequence = last seq, the relay replays the gap, then synchronized. Needs a migration for the per-device cursor table before the test can pass.",
        steps: [
          {
            id: "1",
            tool: "read_file",
            arg: "apps/relay/src/server.ts",
            output: "188 lines",
          },
          {
            id: "2",
            tool: "search_files",
            arg: "afterSequence",
            output: "0 matches",
          },
          {
            id: "3",
            tool: "write_file",
            arg: "apps/relay/src/reconnect.test.ts",
            output: "46 lines",
            add: 46,
            del: 0,
          },
          {
            id: "4",
            tool: "patch",
            arg: "apps/relay/src/server.ts",
            output: "replay from afterSequence, then synchronized",
            add: 31,
            del: 6,
          },
        ],
        live: true,
      },
    ],
  },
  {
    id: "s-ci",
    title: "CI red on main",
    state: "working",
    employee: BUILDER,
    when: "now",
    started: "Today 09:31",
    folder: LILOS,
    branch: {
      name: "fix/ac-83",
      detail: "new worktree off main · .lilos/wt/lil-11",
    },
    model: "Claude Opus 5.5 · High",
    session: "ses_c03e",
    entries: [
      {
        kind: "user",
        id: "u1",
        time: "09:31",
        text: "Why is CI red on main?",
      },
      {
        kind: "agent",
        id: "g1",
        time: "09:31",
        live: true,
        // Builder's own task list for this turn (issue #175): ticks as it works.
        plan: {
          id: "tasks-ci",
          kind: "tasks",
          version: 1,
          status: "approved",
          steps: [
            { text: "Reproduce ac-83 locally", status: "pending" },
            { text: "Find where img.avatar comes from", status: "pending" },
            { text: "Scope the locator in the spec", status: "pending" },
            { text: "Re-run ac-83", status: "pending" },
            { text: "Commit the fix", status: "pending" },
          ],
        },
        reasoning:
          "Start from the failing run, not from guesses. The last green was c91ad23; only ac-83 changed since.",
        thought: 3,
        steps: [
          {
            id: "1",
            tool: "terminal",
            arg: "gh run view 36304038507 --log-failed",
            output: "ac-83 › DM feed row avatar · timeout 30000ms",
          },
          {
            id: "2",
            tool: "read_file",
            arg: "e2e/ac-83.spec.ts",
            output: "74 lines",
          },
        ],
      },
    ],
  },
  {
    /* #555: a turn that died on an engine error — the failure card with
       Retry (web #419). Retry replays the same card and recovers. */
    id: "s-failed",
    title: "Rebuild the search index",
    state: "failed",
    employee: BUILDER,
    when: "Yesterday",
    started: "Yesterday 18:12",
    folder: LILOS,
    branch: { name: "main", detail: "read-only · no worktree" },
    model: "Claude Opus 5.5 · High",
    session: "ses_d41f",
    failure: { kind: "generic", text: "engine lost contact mid-turn" },
    entries: [
      {
        kind: "user",
        id: "u1",
        time: "18:12",
        text: "Rebuild the messages search index — it misses hits from archived threads.",
      },
      {
        kind: "agent",
        id: "g1",
        time: "18:12",
        thought: 4,
        reasoning:
          "The indexer skips archived conversations on the backfill pass. Rebuild, then re-run the search spec.",
        steps: [
          {
            id: "1",
            tool: "read_file",
            arg: "apps/relay/src/search.ts",
            output: "212 lines · channelId, conversationId filters",
          },
          {
            id: "2",
            tool: "terminal",
            arg: "bun run search:reindex --include-archived",
            output: "reindexing 41,208 rows…",
          },
        ],
        failed: "engine lost contact mid-turn",
      },
    ],
  },
  {
    /* #555: a send queued behind the turn parked in the Not-sent tray
       when Stop landed — one parked message wraps so Send now shows
       what it sends (web: NotSentTray). */
    id: "s-stopped",
    title: "Cache the embedding lookups",
    state: "stopped",
    employee: BUILDER,
    when: "Yesterday",
    started: "Yesterday 17:02",
    folder: LILOS,
    branch: { name: "main", detail: "read-only · no worktree" },
    model: "Claude Opus 5.5 · High",
    session: "ses_e118",
    entries: [
      {
        kind: "user",
        id: "u1",
        time: "17:02",
        text: "Cache the embedding lookups — the DM search re-fetches every keystroke.",
      },
      {
        kind: "agent",
        id: "g1",
        time: "17:02",
        thought: 2,
        reasoning:
          "Memoize by conversation id so repeat queries hit the warm index.",
        steps: [
          {
            id: "1",
            tool: "read_file",
            arg: "apps/relay/src/search.ts",
            output: "212 lines · conversation-scoped keys",
          },
        ],
        stopped: true,
      },
      {
        kind: "user",
        id: "u2",
        time: "17:03",
        text: "Also warm the embedding cache on app start so the first search doesn't stall.",
        notSent: true,
      },
    ],
  },
  {
    id: "s-flake",
    title: "ac-80 flake",
    state: "needs-you",
    employee: { id: "reviewer", name: "Reviewer", tone: "violet" },
    when: "2m",
    started: "Today 09:24",
    folder: LILOS,
    branch: { name: "main", detail: "read-only · no worktree" },
    model: "GPT-5.5 Codex · Medium",
    session: "ses_77a0",
    prs: [
      {
        number: 86,
        title: "DM feed: avatar above the name row",
        status: "open",
        checks: "pending",
      },
    ],
    entries: [
      {
        kind: "user",
        id: "u1",
        time: "09:24",
        text: "Is the ac-80 flake really fixed? Prove it before I merge #86.",
      },
      {
        kind: "agent",
        id: "g1",
        time: "09:26",
        thought: 5,
        reasoning:
          "One green run proves nothing for a flake. Read the fix, then repeat the test enough times that a 1-in-10 failure would show.",
        steps: [
          {
            id: "1",
            tool: "terminal",
            arg: "git log -3 --oneline -- e2e/ac-80.spec.ts",
            output:
              "982f9ab DM feed row: avatar sits a line above\n5536c54 DM: user's own avatar is a faint grey Y",
          },
          {
            id: "2",
            tool: "read_file",
            arg: "e2e/ac-80.spec.ts",
            output: "61 lines · waits for img.complete now",
          },
        ],
        text: "The fix waits for the avatar image to finish loading before it measures. Looks right, but I want to run it **20 times** to be sure.",
        approval: APPROVALS[1],
      },
    ],
  },
  {
    id: "s-launch",
    title: "Launch thread",
    state: "needs-you",
    employee: { id: "marketer", name: "Marketer", tone: "sunset" },
    when: "1m",
    started: "Today 09:02",
    model: "Claude Sonnet 5 · Medium",
    session: "ses_31c4",
    entries: [
      {
        kind: "user",
        id: "u1",
        time: "09:02",
        text: "Draft the launch thread for the mobile app. Short, no hype.",
      },
      {
        kind: "agent",
        id: "g1",
        time: "09:08",
        thought: 7,
        reasoning:
          "Lead with what you can do from the phone (approve, watch, reply), not with the tech. Six posts, two screenshots, no emoji walls.",
        steps: [
          {
            id: "1",
            tool: "web_search",
            arg: "agent app launch thread examples",
            output: "8 results",
          },
          {
            id: "2",
            tool: "write_file",
            arg: "launch-thread.md",
            output: "6 posts",
            add: 48,
            del: 0,
          },
        ],
        text: "Draft is ready: **6 posts** and 2 screenshots (Home and the approval dock). Want me to post it?",
        approval: APPROVALS[2],
      },
    ],
  },
  {
    /* #420: a `question` ask — one answered earlier in the thread (the
       decided receipt), one still open (the card: options + free text). */
    id: "s-question",
    title: "Where #96 lands",
    state: "needs-you",
    employee: { id: "reviewer", name: "Reviewer", tone: "violet" },
    when: "now",
    started: "Today 10:04",
    folder: LILOS,
    branch: { name: "main", detail: "read-only · no worktree" },
    model: "Claude Opus 5.5 · High",
    session: "ses_9b42",
    usage: "52.1k in · 4.2k out · 38k cached",
    entries: [
      {
        kind: "user",
        id: "u1",
        time: "10:04",
        text: "Review #96 before the release cut — and figure out where it should land.",
      },
      {
        kind: "agent",
        id: "g1",
        time: "10:06",
        thought: 4,
        reasoning:
          "Read the diff, run its test slice, then decide whether it merges straight to main.",
        steps: [
          {
            id: "1",
            tool: "terminal",
            arg: "gh pr diff 96 --stat",
            output: "apps/relay/replay.ts · +64 −11 · e2e/replay.spec.ts · +40",
          },
          {
            id: "2",
            tool: "terminal",
            arg: "bun test apps/relay",
            output: "✓ 12 pass · 0 fail (1.9s)",
          },
        ],
        text: "The diff is clean — relay replay fix plus a regression test. Before I merge, one thing: should it land **straight on main** or go through the release branch?",
        decided: { approved: true, question: true, what: "Merge to main" },
      },
      {
        kind: "agent",
        id: "g2",
        time: "10:09",
        thought: 3,
        reasoning:
          "Merging to main keeps it out of the release; that leaves the timing call — cherry-pick it into the cut or let it ride the next train.",
        steps: [
          {
            id: "1",
            tool: "terminal",
            arg: "git merge --squash origin/pr/96",
            output:
              "Squash commit — not updating HEAD\n 2 files changed, +104 −11",
          },
        ],
        text: "Merged to `main` as `9c41d0e`. Now the timing call is yours — this changes what the release notes need.",
        approval: APPROVALS[3],
      },
    ],
  },
  {
    id: "s-inbox",
    title: "Morning inbox",
    state: "done",
    employee: { id: "default", name: "Default", tone: "stone" },
    when: "Mon",
    started: "Mon 08:00",
    model: "Qwen 3.8 Flash · Low",
    session: "ses_02be",
    entries: [
      {
        kind: "user",
        id: "u1",
        time: "Mon 08:00",
        text: "Every morning: sort my inbox and tell me only what needs me.",
      },
      {
        kind: "agent",
        id: "g1",
        time: "Mon 08:01",
        thought: 2,
        reasoning:
          "Label, archive newsletters, surface only threads waiting on Oscar.",
        steps: [
          {
            id: "1",
            tool: "email",
            arg: "in:inbox newer_than:1d",
            output: "23 threads",
          },
          {
            id: "2",
            tool: "email",
            arg: "archive 17 newsletters",
            output: "archived 17",
          },
        ],
        text: "Sorted 23 threads. **2 need you:** the Apple review reply and Sam's invoice.",
        footer: { dur: 41, model: "Qwen 3.8 Flash", effort: "Low" },
      },
    ],
  },

  {
    id: "s-markdown",
    title: "Markdown rendering QA",
    state: "done",
    employee: BUILDER,
    when: "Today",
    started: "Today 10:04",
    folder: LILOS,
    branch: { name: "main", detail: "read-only · no worktree" },
    model: "Claude Sonnet 5 · Medium",
    session: "ses_7f3d",
    usage: "9.1k in · 3.4k out",
    entries: [
      {
        kind: "user",
        id: "u1",
        time: "10:04",
        text: "Send me the markdown sample — every fenced block kind in one reply.",
      },
      {
        kind: "agent",
        id: "g1",
        time: "10:05",
        thought: 3,
        reasoning:
          "The seven-block sample verbatim — ts, python, bash, a long JSON line, markdown inside a fence, an unlabelled block and a diff.",
        text: `Here's the change set — seven blocks, each its own kind:

The handler in TypeScript:

\`\`\`ts
export async function resolveRoute(path: string): Promise<Route> {
  // keep the trailing slash stable — the web router depends on it
  const normalized = path.replace(/\\/+$/, "") || "/";
  return match(normalized);
}
\`\`\`

Same shape in Python:

\`\`\`python
def resolve_route(path: str) -> Route:
    # keep the trailing slash stable
    normalized = re.sub(r"/+$", "", path) or "/"
    return match(normalized)
\`\`\`

And the bash one-liner for ops:

\`\`\`bash
curl -fsSL https://relay.local/health | jq -e '.ok == true'
\`\`\`

The config payload — one long line, no breaks:

\`\`\`json
{"relay":{"host":"127.0.0.1","port":4577,"tls":false,"retry":{"attempts":8,"backoffMs":[300,600,1200,2400]},"features":{"phonePairing":true,"pushNotifications":true,"workbench":{"terminal":true,"diffs":true,"previews":false}}}}
\`\`\`

This fence holds markdown-looking text that must stay literal:

\`\`\`markdown
| not | a | table |
| --- | --- | --- |
**not bold** and - not a bullet and \`not inline code\`
\`\`\`

An unlabelled block with indented content:

\`\`\`
    step one: fetch the token
      step two: pair the device
        step three: listen on :4577
\`\`\`

Finally the diff for the change itself:

\`\`\`diff
@@ -3,6 +3,7 @@
 const route = match(path);
-  return route.withFallback();
+  return route.strict();
+  // fallback moved to the caller (#259)
\`\`\`

Each block keeps its own shape — mono, panel, copy — the thread prose around them stays normal.`,
        footer: { dur: 9, model: "Sonnet 5", effort: "Medium" },
      },
      {
        kind: "user",
        id: "u2",
        time: "10:09",
        text: "Now the table sample — the open-items breakdown, the wide one, and the aligned one.",
      },
      {
        kind: "agent",
        id: "g2",
        time: "10:10",
        thought: 4,
        reasoning:
          "The three-table sample verbatim — a two-column breakdown with long Vietnamese cell text, a six-column status table that needs horizontal scroll, and a right/center/left aligned one.",
        text: `Two open items — here's the breakdown:

| Issue | What it needs |
| --- | --- |
| Apple review reply | Cần trả lời reviewer trong 24h — họ hỏi về quyền camera, cần giải thích pairing flow chứ không phải quét ảnh. |
| Sam's invoice | Hóa đơn tháng 9 chưa chốt — cần xác nhận số giờ trước khi gửi lại cho kế toán cuối tuần này. |

And a wider one for scroll:

| Slice | AC | Tier | Status | Owner | Notes |
| --- | --- | --- | --- | --- | --- |
| #259 code blocks | 5 | Normal | In PR | Devin | fences + highlight + copy |
| #306 tables | 6 | Normal | **Building** | Devin | GFM tables, scroll inside the message |
| #307 desktop chrome | 7 | Normal | \`agent-ready\` | unassigned | Shiki plugin + one-row header |

Alignment matters too — right, center, left:

| Rank | Name | Score |
| ---: | :---: | :--- |
| 1 | Relay | 98.2 |
| 12 | Harness | 87.04 |
| 123 | Desktop | 76.345 |

Everything outside the tables renders as normal prose.`,
        footer: { dur: 11, model: "Sonnet 5", effort: "Medium" },
      },
      {
        kind: "user",
        id: "u3",
        time: "10:14",
        text: "md: links",
      },
      {
        kind: "agent",
        id: "g3",
        time: "10:15",
        thought: 1,
        reasoning:
          "Reply-safety check — the remote image and the non-web links are the point.",
        /* The #566 sample verbatim — the phone draws no images and makes no
           links, so every piece must come out as inert text. Identical copy
           in packages/engine-fake/src/markdown-samples.ts. */
        text: `Here's what I pulled up:

![network map](https://img.example.com/lilos-topology.png?session=abc123)

- Docs: [architecture notes](https://lilos.dev/docs/architecture) — a normal link.
- Watch-outs: [the payload](javascript:alert(1)), [a local file](file:///etc/passwd) and [the share](smb://files.local/share) must stay text, not links.
- Or ping [ops](mailto:ops@lilos.dev) if the map looks wrong.`,
        footer: { dur: 4, model: "Sonnet 5", effort: "Medium" },
      },
    ],
  },
];
