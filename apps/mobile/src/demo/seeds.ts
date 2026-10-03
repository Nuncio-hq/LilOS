import { SEED_MARKDOWN } from "./seeds-markdown";
import type { DemoPlan, DemoScript, SeedConversation } from "./types";

/* The demo world's seeded conversations (#168): the prototype's thread
   corpus (fake-team.ts / fake-subagents.ts / fake-plan.ts) re-cut as wire
   data — messages + the scripted engine turns that produced them. `hold`
   turns are still open where the prototype showed them live. */

const LILOS_DIR = "~/Desktop/Oscar/LilOS";
const OPUS = {
  model: "claude-opus-5-5",
  provider: "anthropic-cliproxy",
  effort: "high",
};
const SONNET = {
  model: "claude-sonnet-5",
  provider: "anthropic-cliproxy",
  effort: "medium",
};

const APPROVAL_OPTS = ["once", "always", "deny"] as const;

const ASK_FLAKE = "a-flake";
const ASK_POST = "a-post";
const ASK_MIGRATE = "a-migrate";
const ASK_PUSH = "a-push";
const ASK_PLAN = "a-plan";

/* ── held-at-ask continuations (FLAKE/POST, approve/deny) ────────────────── */

const FLAKE_YES: DemoScript = {
  steps: [
    {
      tool: "terminal",
      arg: "bunx playwright test ac-80 --repeat-each 20",
      output: "✓ 20 passed (1m 12s)",
      ms: 3200,
    },
  ],
  text: "**20 of 20 passed.** The fix holds, so #86 is safe to merge.",
};
const FLAKE_NO: DemoScript = {
  text: "OK, skipping the repeat run. One green run is weak proof for a flake, so I'd hold #86 until it's shown.",
};

const POST_YES: DemoScript = {
  steps: [
    {
      tool: "x_post",
      arg: "launch-thread.md · 6 posts",
      output: "posted · x.com/lilos_app/status/1839204",
      ms: 2200,
    },
  ],
  text: "Posted. The first post is live; I'll watch the replies for an hour and flag anything that needs you.",
};
const POST_NO: DemoScript = {
  text: "Not posting. The draft stays in `launch-thread.md` if you want to edit it.",
};

const MIGRATE_YES: DemoScript = {
  steps: [
    {
      tool: "terminal",
      arg: "bun run db:migrate --env dev",
      output: "✓ 0007_device_cursor · 1 table created",
      ms: 2000,
    },
    {
      tool: "terminal",
      arg: "bun test apps/relay",
      output: "✓ 12 pass · 0 fail (1.9s)",
      ms: 2400,
    },
    {
      tool: "terminal",
      arg: 'git commit -am "relay: replay the gap after sleep"',
      output: "[feat/relay-reconnect 8d02a1e] 3 files changed",
      ms: 700,
    },
  ],
  text: "Migration ran and the relay tests are green, **12 of 12**. After the Mac wakes, the phone now replays everything it missed from `afterSequence`.",
};
const MIGRATE_NO: DemoScript = {
  text: "You said no, so I left the database alone. The reconnect code is on the branch; the test stays red until the table exists.",
};

const PUSH_YES: DemoScript = {
  steps: [
    {
      tool: "terminal",
      arg: "git push -u origin fix/ac-83",
      output: "branch 'fix/ac-83' set up to track 'origin/fix/ac-83'",
      ms: 1400,
    },
    {
      tool: "terminal",
      arg: "gh pr create --fill",
      output: "https://github.com/Nuncio-hq/LilOS/pull/97",
      ms: 1600,
    },
  ],
  text: "Opened **PR #97**. CI is running on it; I'll tell you if it goes red.",
  pr: {
    number: 97,
    url: "https://github.com/Nuncio-hq/LilOS/pull/97",
    repo: "Nuncio-hq/LilOS",
    title: "e2e: scope ac-83 avatar locator",
    state: "open",
    draft: false,
    head: "fix/ac-83",
    base: "main",
    openedAt: "2026-10-02T09:44:00Z",
    checks: "pending",
  },
};
const PUSH_NO: DemoScript = {
  text: "OK, not pushing. The fix is committed on `fix/ac-83` if you want to look first.",
};

/* ── the plan thread (#175/182 coverage) ─────────────────────────────────── */

const PLAN_V1: DemoPlan = {
  planId: "plan-1",
  kind: "plan",
  version: 1,
  goal: "The relay client reconnects on its own after a drop, backing off up to 30s, without losing events.",
  risks: [
    "Reconnect storms if many clients drop at once: adding jitter.",
    "Web and mobile share this client; both need a reload test.",
  ],
  steps: [
    {
      text: "Add a backoff helper (250ms → 30s, jitter)",
      files: ["packages/client-runtime/src/backoff.ts"],
      status: "pending",
    },
    {
      text: "Use it in the socket's reconnect loop",
      files: ["packages/client-runtime/src/socket.ts"],
      status: "pending",
    },
    {
      text: "Resume from the last seq after reconnect",
      files: ["packages/client-runtime/src/sync.ts"],
      status: "pending",
    },
    {
      text: "Tests: drop → retry → resume, 30s cap",
      files: ["packages/client-runtime/test/reconnect.test.ts"],
      status: "pending",
    },
    {
      text: 'Show "Reconnecting…" in the status banner',
      files: ["packages/ui/src/shell/banner.tsx"],
      status: "pending",
    },
  ],
};

/** The work the approved plan runs — one tool call per plan step, ticking
    the plan's own step list as it goes (same planId, same version merges). */
const PLAN_WORK: DemoScript = {
  tickPlan: PLAN_V1,
  steps: [
    {
      tool: "write_file",
      arg: "packages/client-runtime/src/backoff.ts",
      output: "24 lines",
      add: 14,
      del: 0,
      patch:
        "@@ -0,0 +1,5 @@\n+/** 250ms … 30s, ±20% jitter. */\n+export function backoff(attempt: number) {\n+  const base = Math.min(30_000, 250 * 2 ** attempt)\n+  return base * (0.8 + Math.random() * 0.4)\n+}",
      ms: 1400,
    },
    {
      tool: "patch",
      arg: "packages/client-runtime/src/socket.ts",
      output: "reconnect uses backoff()",
      add: 6,
      del: 2,
      patch:
        '@@ -41,3 +41,4 @@ function onClose() {\n-  setTimeout(connect, 1000)\n+  const wait = backoff(this.attempt++)\n+  this.emit("reconnecting", { in: wait })\n+  setTimeout(connect, wait)',
      ms: 1400,
    },
    {
      tool: "patch",
      arg: "packages/client-runtime/src/sync.ts",
      output: "hello { afterSequence }",
      add: 3,
      del: 1,
      patch:
        '@@ -18,3 +18,3 @@ export function hello(s: Sync) {\n-  return { kind: "hello" }\n+  return { kind: "hello", afterSequence: s.lastSeq ?? 0 }',
      ms: 1200,
    },
    {
      tool: "terminal",
      arg: "bun test packages/client-runtime",
      output:
        "✓ retries with backoff\n✓ resumes after lastSeq\n✓ caps at 30s\n\n3 pass · 0 fail",
      ms: 2000,
    },
    {
      tool: "patch",
      arg: "packages/ui/src/shell/banner.tsx",
      output: "Reconnecting… banner",
      add: 4,
      del: 0,
      patch:
        '@@ -12,3 +12,5 @@\n+  if (state === "reconnecting")\n+    return <StatusBanner tone="amber">Reconnecting…</StatusBanner>',
      ms: 1200,
    },
  ],
  text: "Done — the client reconnects on its own now, with jittered backoff up to 30s, and `events.since` resumes from the last seq. All 3 tests pass. **PR #98** has the diff.",
  pr: {
    number: 98,
    url: "https://github.com/Nuncio-hq/LilOS/pull/98",
    repo: "Nuncio-hq/LilOS",
    title: "client-runtime: auto-reconnect with backoff",
    state: "open",
    draft: false,
    head: "lil-11-reconnect",
    base: "main",
    openedAt: "2026-10-02T11:31:00Z",
    checks: "pending",
  },
};

const PLAN_REJECT: DemoScript = {
  text: "Scrapped. The plan is marked rejected — say what to change and I'll write v2.",
};

/* The s-ci task list (prototype "CI red on main" turn plan). */
const CI_TASKS = [
  "Reproduce ac-83 locally",
  "Find where img.avatar comes from",
  "Scope the locator in the spec",
  "Re-run ac-83",
  "Commit the fix",
];

/* ── The seeded world ────────────────────────────────────────────────────── */

export const SLEEP_THREAD = "s-sleep";
const SEQ_THREAD = "s-seq";
const REVIEWER_HELPER = { employeeRef: "reviewer", sessionRef: "ses_rv21" };

export const DEMO_SEEDS: SeedConversation[] = [
  {
    id: "s-gap",
    title: "First harness connection",
    channelId: "ch-builder",
    session: "ses_4a19",
    cwd: LILOS_DIR,
    ...OPUS,
    ageMin: 60 * 26,
    legs: [
      {
        text: "What's left before the relay can accept its first harness connection?",
        script: {
          reasoning:
            "Oscar asks for the gap list, not a build plan. No ticket, so read main only. Check the relay package and the contracts, list only what blocks one harness from connecting.",
          steps: [
            {
              tool: "search_files",
              arg: "WebSocketServer in apps/relay",
              output: "0 matches",
            },
            {
              tool: "read_file",
              arg: "packages/contracts/src/envelope.ts",
              output: "58 lines · seq, kind, body",
            },
            {
              tool: "read_file",
              arg: "apps/relay/package.json",
              output: '{ "name": "@lilos/relay", "main": "src/index.ts" }',
            },
          ],
          text: "Three things block it:\n\n- **Relay has no socket yet.** `apps/relay` is an empty package.\n- **No auth handshake.** The envelope has `seq` but no member token.\n- **No harness package.** Nothing dials out yet.\n\nThe first two are one ticket. The third is its own.",
          usage: {
            input: 38_400,
            output: 2900,
            reasoning: 900,
            cache: 24_000,
            context: 41_300,
            contextWindow: 200_000,
          },
        },
      },
      {
        text: "Which one first?",
        script: {
          reasoning:
            "Order by dependency: the harness needs something to dial.",
          text: "Relay socket + token check first. The harness has nothing to dial without it, and it's the smaller change (about 150 lines).",
          usage: {
            input: 2400,
            output: 300,
            reasoning: 100,
            cache: 800,
            context: 2_700,
          },
        },
      },
    ],
  },
  {
    id: "s-pair",
    title: "Pair phone dialog",
    channelId: "ch-builder",
    session: "ses_9e27",
    cwd: `${LILOS_DIR}/.lilos/wt/lil-8`,
    workspace: {
      mode: "new",
      repoPath: LILOS_DIR,
      branch: "proto/pair-phone",
      base: "main",
    },
    ...OPUS,
    ageMin: 60 * 20,
    legs: [
      {
        text: "Add a Pair phone dialog on the Mac: QR, address and a one-time code.",
        script: {
          reasoning:
            "Worktree off main, so I can edit. The dialog belongs in packages/ui (props in, callbacks out); the prototype only wires fake data. Code expires, so the dialog needs a countdown and a refresh.",
          steps: [
            {
              tool: "read_file",
              arg: "packages/ui/src/dialogs/hire-dialog.tsx",
              output: "303 lines",
            },
            {
              tool: "search_files",
              arg: "qrcode in packages/ui",
              output: "0 matches",
            },
            {
              tool: "terminal",
              arg: "bun add qrcode.react --cwd packages/ui",
              output: "installed qrcode.react@4.2.0",
            },
            {
              tool: "write_file",
              arg: "packages/ui/src/dialogs/pair-phone-dialog.tsx",
              output: "242 lines",
              add: 242,
              del: 0,
            },
            {
              tool: "patch",
              arg: "prototype/web/src/App.tsx",
              output: "wire PairPhoneDialog to the Mac menu",
              add: 18,
              del: 4,
            },
            {
              tool: "terminal",
              arg: "bun run verify",
              output:
                "biome   ✓ 212 files\ntsc     ✓\nvitest  ✓ 64 passed\nplaywright ✓ 31 passed (48.2s)",
            },
          ],
          text: "Done on `proto/pair-phone`. The dialog shows the **QR**, the Tailscale address and a 6-digit code that expires in 10 minutes, with a Refresh button.\n\n- Lives in `packages/ui`, props in, callbacks out.\n- Opens from the Mac menu → **Pair phone**.",
          usage: {
            input: 71_200,
            output: 6100,
            reasoning: 2100,
            cache: 52_000,
            context: 77_300,
            contextWindow: 200_000,
          },
        },
      },
      {
        text: "Make the code bigger and mono.",
        script: {
          reasoning: "One class change on the code block.",
          steps: [
            {
              tool: "patch",
              arg: "packages/ui/src/dialogs/pair-phone-dialog.tsx",
              output: "text-3xl font-mono tracking-[0.3em]",
              add: 1,
              del: 1,
            },
          ],
          text: "Bigger and mono now, with wider letter spacing so it reads aloud easily.",
          usage: {
            input: 1800,
            output: 240,
            reasoning: 80,
            cache: 600,
            context: 2_040,
          },
        },
      },
    ],
  },
  {
    id: "s-relay",
    title: "Relay handshake",
    channelId: "ch-builder",
    session: "ses_b71d",
    cwd: `${LILOS_DIR}/.lilos/wt/lil-9`,
    workspace: {
      mode: "existing",
      repoPath: LILOS_DIR,
      branch: "feat/relay-reconnect",
    },
    ...OPUS,
    ageMin: 9,
    legs: [
      {
        text: "Wire the relay handshake so the phone can reconnect after the Mac sleeps.",
        script: {
          reasoning:
            "Events already carry seq. On reconnect the phone sends afterSequence = last seq, the relay replays the gap, then synchronized. Needs a migration for the per-device cursor table before the test can pass.",
          steps: [
            {
              tool: "read_file",
              arg: "apps/relay/src/server.ts",
              output: "188 lines",
            },
            { tool: "search_files", arg: "afterSequence", output: "0 matches" },
            {
              tool: "write_file",
              arg: "apps/relay/src/reconnect.test.ts",
              output: "46 lines",
              add: 46,
              del: 0,
            },
            {
              tool: "patch",
              arg: "apps/relay/src/server.ts",
              output: "replay from afterSequence, then synchronized",
              add: 31,
              del: 6,
            },
          ],
          hold: true,
        },
      },
    ],
  },
  {
    id: "s-ci",
    title: "CI red on main",
    channelId: "ch-builder",
    session: "ses_c03e",
    cwd: `${LILOS_DIR}/.lilos/wt/lil-11`,
    workspace: {
      mode: "existing",
      repoPath: LILOS_DIR,
      branch: "fix/ac-83",
    },
    ...OPUS,
    ageMin: 7,
    legs: [
      {
        text: "Why is CI red on main?",
        script: {
          reasoning:
            "Start from the failing run, not from guesses. The last green was c91ad23; only ac-83 changed since.",
          tasks: CI_TASKS,
          steps: [
            {
              tool: "terminal",
              arg: "gh run view 36304038507 --log-failed",
              output: "ac-83 › DM feed row avatar · timeout 30000ms",
            },
            {
              tool: "read_file",
              arg: "e2e/ac-83.spec.ts",
              output: "74 lines",
            },
          ],
          hold: true,
        },
      },
    ],
  },
  {
    id: "s-flake",
    title: "ac-80 flake",
    channelId: "ch-reviewer",
    session: "ses_77a0",
    cwd: LILOS_DIR,
    model: "gpt-6-astra",
    provider: "openai-codex",
    effort: "medium",
    ageMin: 12,
    legs: [
      {
        text: "Is the ac-80 flake really fixed? Prove it before I merge #86.",
        script: {
          reasoning:
            "One green run proves nothing for a flake. Read the fix, then repeat the test enough times that a 1-in-10 failure would show.",
          steps: [
            {
              tool: "terminal",
              arg: "git log -3 --oneline -- e2e/ac-80.spec.ts",
              output:
                "982f9ab DM feed row: avatar sits a line above\n5536c54 DM: user's own avatar is a faint grey Y",
            },
            {
              tool: "read_file",
              arg: "e2e/ac-80.spec.ts",
              output: "61 lines · waits for img.complete now",
            },
          ],
          text: "The fix waits for the avatar image to finish loading before it measures. Looks right, but I want to run it **20 times** to be sure.",
          ask: {
            id: ASK_FLAKE,
            request: {
              kind: "approval",
              command: "bunx playwright test ac-80 --repeat-each 20",
              description:
                "Wants to re-run the flaky DM identity test 20× to prove the fix.",
              options: [...APPROVAL_OPTS],
            },
            onApprove: FLAKE_YES,
            onDeny: FLAKE_NO,
          },
        },
      },
    ],
  },
  {
    id: "s-launch",
    title: "Launch thread",
    channelId: "ch-marketer",
    session: "ses_31c4",
    ...SONNET,
    ageMin: 25,
    legs: [
      {
        text: "Draft the launch thread for the mobile app. Short, no hype.",
        script: {
          reasoning:
            "Lead with what you can do from the phone (approve, watch, reply), not with the tech. Six posts, two screenshots, no emoji walls.",
          steps: [
            {
              tool: "web_search",
              arg: "agent app launch thread examples",
              output: "8 results",
            },
            {
              tool: "write_file",
              arg: "launch-thread.md",
              output: "6 posts",
              add: 48,
              del: 0,
            },
          ],
          text: "Draft is ready: **6 posts** and 2 screenshots (Home and the approval dock). Want me to post it?",
          ask: {
            id: ASK_POST,
            request: {
              kind: "approval",
              command: "post launch-thread.md · 6 posts to X",
              description: "Ready to post the launch thread on X.",
              options: [...APPROVAL_OPTS],
            },
            onApprove: POST_YES,
            onDeny: POST_NO,
          },
        },
      },
    ],
  },
  {
    id: "s-inbox",
    title: "Morning inbox",
    channelId: "ch-default",
    session: "ses_02be",
    model: "qwen3.8-flash-next",
    provider: "hpc",
    effort: "low",
    ageMin: 60 * 30,
    legs: [
      {
        text: "Every morning: sort my inbox and tell me only what needs me.",
        script: {
          reasoning:
            "Label, archive newsletters, surface only threads waiting on Oscar.",
          steps: [
            {
              tool: "email",
              arg: "in:inbox newer_than:1d",
              output: "23 threads",
            },
            {
              tool: "email",
              arg: "archive 17 newsletters",
              output: "archived 17",
            },
          ],
          text: "Sorted 23 threads. **2 need you:** the Apple review reply and Sam's invoice.",
          usage: {
            input: 9100,
            output: 800,
            reasoning: 200,
            cache: 1500,
            context: 9_900,
          },
        },
      },
    ],
  },
  SEED_MARKDOWN,
  {
    id: SLEEP_THREAD,
    title: "Turns lost after sleep",
    channelId: "ch-builder",
    session: "ses_9d51",
    cwd: `${LILOS_DIR}/.lilos/wt/lil-9`,
    workspace: {
      mode: "existing",
      repoPath: LILOS_DIR,
      branch: "lil-9-sleep-replay",
    },
    ...OPUS,
    ageMin: 4,
    legs: [
      {
        text: "Turns get lost when the Mac sleeps. Find out why: relay and harness in parallel, and ask Reviewer to check the envelope.",
        script: {
          reasoning:
            "Relay replay and harness wake handling are independent reads: two subagents. The contract question belongs to Reviewer.",
          subagents: [
            {
              id: "sa-relay",
              name: "Trace relay replay",
              task: "Read apps/relay: how does it replay events after a harness reconnects? Report file:line, no edits.",
              steps: [
                {
                  tool: "search_files",
                  arg: "afterSequence",
                  output: "3 matches",
                },
                {
                  tool: "read_file",
                  arg: "apps/relay/src/feed.ts",
                  output: "212 lines",
                },
              ],
              result:
                "Relay replays from `afterSequence` correctly (`feed.ts:88`). **The gap is not in the relay.**",
            },
            {
              id: "sa-harness",
              name: "Harness sleep path",
              task: "Find what the harness does with a running turn when the Mac sleeps. Start a test watcher.",
              steps: [
                {
                  tool: "read_file",
                  arg: "apps/harness/src/turns.ts",
                  output: "140 lines",
                },
                {
                  tool: "terminal",
                  arg: "bun test --watch apps/harness",
                  output: "Started in background",
                },
              ],
              result:
                "`onWake` ends the turn but never resumes from `lastSeq` (`turns.ts:56`), so events sent during sleep are dropped.",
            },
            {
              id: "sa-issues",
              name: "Search Hermes issues",
              task: "Check hermes-agent issues for known sleep/resume bugs.",
              steps: [
                {
                  tool: "web_search",
                  arg: "hermes-agent resume after sleep",
                  output: "403 rate limited",
                },
              ],
              ends: "failed",
              result:
                "GitHub search was rate-limited (403). Stopped without an answer.",
            },
            {
              id: "sa-review",
              name: "Check envelope seq",
              task: "Confirm envelope seq is monotonic per session.",
              employee: REVIEWER_HELPER,
              steps: [],
              wait: 1200,
              result: "seq is monotonic per session; the contract holds.",
            },
          ],
          jobs: [
            {
              jobId: "j-dev",
              command: "bun run dev",
              status: "running",
              url: "http://localhost:5173",
              tail: "$ bun run dev\nvite v6 ready in 214 ms\n➜  Local:   http://localhost:5173/\n10:48:02 [vite] hmr update /src/App.tsx",
            },
            {
              jobId: "j-watch",
              command: "bun test --watch apps/harness",
              status: "running",
              by: "Harness sleep path",
              tail: "$ bun test --watch apps/harness\n✓ reconnect › replays afterSequence\n✓ reconnect › backs off to 30s\n\n2 pass · 0 fail · watching…",
            },
            {
              jobId: "j-build",
              command: "bun run build",
              status: "failed",
              exitCode: 1,
              tail: "$ bun run build\nerror TS2345: apps/harness/src/turns.ts:57\n  Argument of type 'number | undefined' is not assignable to parameter of type 'number'.\nBuild failed in 38s",
            },
          ],
          text: "Found it. The relay is fine; the **harness** drops events: `onWake` never resumes from `lastSeq`. Reviewer confirmed `seq` is monotonic, so resuming is safe.",
          usage: {
            input: 91_800,
            output: 7400,
            reasoning: 2600,
            cache: 64_000,
            context: 99_200,
            contextWindow: 200_000,
          },
        },
      },
      /* The second message sits queued — opening the thread plays its turn
         (the sleep fix fan-out) live, like the prototype's playOnOpen. */
      { text: "Good. Write the fix and a test, and have Reviewer look at it." },
    ],
  },
  {
    id: SEQ_THREAD,
    title: "Envelope seq (for Builder)",
    channelId: "ch-reviewer",
    session: "ses_rv21",
    cwd: LILOS_DIR,
    ...OPUS,
    ageMin: 6,
    legs: [
      {
        text: "From Builder: confirm envelope seq is monotonic per session.",
        script: {
          reasoning: "",
          steps: [
            {
              tool: "read_file",
              arg: "packages/contracts/src/envelope.ts",
              output: "58 lines",
            },
            { tool: "search_files", arg: "seq =", output: "2 matches" },
          ],
          text: "`seq` is assigned in one place (`feed.ts:41`) and only increments. Monotonic per session; the contract holds.",
          usage: {
            input: 3200,
            output: 500,
            reasoning: 150,
            cache: 900,
            context: 3_700,
          },
        },
      },
    ],
  },
  {
    id: "s-plan",
    title: "Reconnect on its own",
    channelId: "ch-builder",
    session: "ses_c7a2",
    cwd: `${LILOS_DIR}/.lilos/wt/lil-11`,
    workspace: {
      mode: "existing",
      repoPath: LILOS_DIR,
      branch: "lil-11-reconnect",
    },
    ...OPUS,
    ageMin: 3,
    legs: [
      {
        text: "The phone loses the relay on flaky wifi and never comes back. Make the client reconnect on its own. Plan first, don't edit yet.",
        script: {
          reasoning:
            "Read socket and sync before proposing anything. Five steps, tests before the banner.",
          steps: [
            {
              tool: "read_file",
              arg: "packages/client-runtime/src/socket.ts",
              output: "96 lines",
            },
            {
              tool: "read_file",
              arg: "packages/client-runtime/src/sync.ts",
              output: "58 lines",
            },
            {
              tool: "search_files",
              arg: "setTimeout(connect",
              output: "1 match",
            },
          ],
          text: "Today the socket retries once after 1s and gives up. Here's my plan. Nothing is edited until you approve.",
          plan: PLAN_V1,
          ask: {
            id: ASK_PLAN,
            request: { kind: "plan", planId: "plan-1" },
            onApprove: PLAN_WORK,
            onDeny: PLAN_REJECT,
          },
          usage: {
            input: 22_400,
            output: 1800,
            reasoning: 700,
            cache: 15_000,
            context: 24_200,
            contextWindow: 200_000,
          },
        },
      },
    ],
  },
];

/* Turns that finish live after the demo opens (prototype startLife):
   Builder's held turns resume on a timer so Home animates idle→working→
   needs-you. */
export const RESUME_ON_OPEN: Record<
  string,
  { delayMs: number; script: DemoScript }
> = {
  "s-relay": {
    delayMs: 900,
    script: {
      steps: [
        {
          tool: "terminal",
          arg: "bun test apps/relay",
          output:
            "✗ reconnect › replays the gap\n  SqliteError: no such table: device_cursor\n\n1 fail · 11 pass",
          ms: 2600,
        },
      ],
      text: "Replay works in code, but the test fails: the `device_cursor` table doesn't exist yet. I need to run the migration first.",
      ask: {
        id: ASK_MIGRATE,
        request: {
          kind: "approval",
          command: "bun run db:migrate --env dev",
          description:
            "Needs to run the database migration before the relay tests can pass.",
          options: [...APPROVAL_OPTS],
        },
        onApprove: MIGRATE_YES,
        onDeny: MIGRATE_NO,
      },
    },
  },
  "s-ci": {
    delayMs: 2400,
    script: {
      steps: [
        {
          tool: "terminal",
          arg: "bunx playwright test ac-83",
          output:
            "✗ ac-83 › DM feed row avatar\n  locator('img.avatar') resolved to 2 elements\n\n1 failed · 12 passed (21.4s)",
          ms: 2200,
        },
        {
          tool: "search_files",
          arg: "img.avatar in packages/ui",
          output: "2 matches · feed-row.tsx, thread-header.tsx",
          ms: 900,
        },
        {
          tool: "patch",
          arg: "e2e/ac-83.spec.ts",
          output: "scope the avatar locator to the feed row",
          add: 2,
          del: 1,
          ms: 1300,
        },
        {
          tool: "terminal",
          arg: "bunx playwright test ac-83",
          output: "✓ 13 passed (19.8s)",
          ms: 2400,
        },
        {
          tool: "terminal",
          arg: 'git commit -am "e2e: scope ac-83 avatar locator"',
          output:
            "[fix/ac-83 4be21c9] 1 file changed, 2 insertions(+), 1 deletion(-)",
          ms: 700,
        },
      ],
      text: "Found it. The test looked for `img.avatar` anywhere on the page, and #83 added a second avatar in the thread header, so it matched **2 elements** and timed out.\n\n- Scoped the locator to the feed row.\n- `ac-83` passes locally, 13 of 13.\n\nOK to push and open a PR?",
      ask: {
        id: ASK_PUSH,
        request: {
          kind: "approval",
          command: "git push -u origin fix/ac-83 && gh pr create --fill",
          description: "Push fix/ac-83 and open a PR so CI runs on the fix.",
          options: [...APPROVAL_OPTS],
        },
        onApprove: PUSH_YES,
        onDeny: PUSH_NO,
      },
    },
  },
};

/* The sleep thread's second turn, played the first time its feed opens —
   two subagents and Reviewer run side by side and finish on screen (#170,
   and the #340 workbench card lands as it settles). */
export const SLEEP_FIX_TURN: DemoScript = {
  reasoning:
    "Fix and test touch different files: two subagents in parallel, then Reviewer.",
  subagents: [
    {
      id: "sb-fix",
      name: "Fix harness resume",
      task: "Make onWake resume from lastSeq after ending the turn. Minimal change.",
      steps: [
        {
          tool: "read_file",
          arg: "apps/harness/src/turns.ts",
          output: "140 lines",
          ms: 1400,
        },
        {
          tool: "patch",
          arg: "apps/harness/src/turns.ts",
          output: "resume from lastSeq",
          add: 4,
          del: 1,
          patch:
            "@@ -52,4 +52,7 @@ function onWake() {\n   endTurn()\n+  // resume from lastSeq so sleep-window events replay\n+  this.sync({ afterSeq: this.lastSeq })",
          ms: 2200,
        },
      ],
      result: "`onWake` now ends the turn **and** resumes from `lastSeq`.",
    },
    {
      id: "sb-test",
      name: "Write sleep regression test",
      task: "Add a test: a turn cut by a clock jump ends interrupted and resumes from lastSeq.",
      delay: 500,
      steps: [
        {
          tool: "search_files",
          arg: "fakeClock",
          output: "helpers.ts",
          ms: 1200,
        },
        {
          tool: "write_file",
          arg: "apps/harness/test/sleep.test.ts",
          output: "31 lines",
          add: 31,
          del: 0,
          ms: 1800,
        },
        {
          tool: "terminal",
          arg: "bun test apps/harness/test/sleep.test.ts",
          output: "✓ a turn cut by sleep resumes\n\n3 pass · 0 fail",
          ms: 2000,
        },
      ],
      result: "Regression test added and passing (3 pass).",
    },
    {
      id: "sb-review",
      name: "Review the fix",
      task: "Review Builder's harness resume fix once the test is green.",
      employee: REVIEWER_HELPER,
      steps: [],
      delay: 800,
      wait: 6200,
      result: "Approved: resume uses the monotonic seq.",
    },
  ],
  text: "Fixed on `lil-9-sleep-replay`: the harness resumes from `lastSeq` after the Mac wakes, with a regression test. **Reviewer approved.** The dev server and test watcher are still running in the background.",
  wb: { diff: true },
};

/* The scripted replies for threads the demo opens or replies to live. */
export function firstTurnScript(opts: {
  text: string;
  cwd?: string;
  workspace?: {
    mode: "new" | "existing";
    repoPath: string;
    branch: string;
    base?: string;
  };
}): DemoScript {
  const words = opts.text
    .replace(/[^\w\s-]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const key = (words[1] ?? words[0] ?? "thing").toLowerCase();
  if (!opts.cwd) {
    return {
      reasoning:
        "No folder, so this is a question, not a change. Look it up, then answer in a few lines.",
      steps: [
        {
          tool: "web_search",
          arg: opts.text.slice(0, 48),
          output: "6 results",
          ms: 1200,
        },
      ],
      text: `Short answer: it depends on how often **${key}** changes. If it's weekly, keep it manual; if it's daily, it's worth a script. Want me to draft one?`,
    };
  }
  const slug =
    opts.text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .split("-")
      .slice(0, 3)
      .join("-") || "task";
  const branch =
    opts.workspace?.mode === "new" ? opts.workspace.branch : undefined;
  const pre =
    branch && opts.workspace
      ? [
          {
            tool: "terminal",
            arg: `git worktree add .lilos/wt/${slug} -b ${branch} ${opts.workspace.base ?? "main"}`,
            output: `Preparing worktree (new branch '${branch}')`,
            ms: 900,
          },
        ]
      : [];
  return {
    reasoning: `Find where ${key} lives before touching anything. Change the smallest thing that does it, then prove it with typecheck and the tests.`,
    steps: [
      ...pre,
      { tool: "terminal", arg: "pwd", output: opts.cwd, ms: 400 },
      { tool: "search_files", arg: key, output: "3 matches", ms: 1000 },
      {
        tool: "read_file",
        arg: `packages/ui/src/${key}.tsx`,
        output: "142 lines",
        ms: 900,
      },
      {
        tool: "patch",
        arg: `packages/ui/src/${key}.tsx`,
        output: "the change",
        add: 14,
        del: 3,
        ms: 1500,
      },
      {
        tool: "terminal",
        arg: "bun run typecheck",
        output: "✓ no errors",
        ms: 1600,
      },
    ],
    text: `Done${branch ? ` on \`${branch}\`` : ""}. I changed \`${key}.tsx\` (**+14 −3**) and typecheck is clean.\n\n- Nothing else touched.\n- Say the word and I'll open a PR.`,
  };
}

/** A follow-up on an open conversation: small patch + re-check when the
    thread worked a folder, a plain answer when it's just chat. */
export function followUpScript(text: string, cwd?: string): DemoScript {
  if (!cwd) {
    return {
      reasoning: "A follow-up question; answer it directly.",
      text: `Got it: "${text}". I'd keep it simple and do that first.`,
    };
  }
  return {
    reasoning:
      "Small follow-up on the same change. Edit the file and re-run the check.",
    steps: [
      {
        tool: "patch",
        arg: "packages/client-runtime/src/backoff.ts",
        output: "follow-up",
        add: 4,
        del: 2,
        ms: 1300,
      },
      {
        tool: "terminal",
        arg: "bun run typecheck",
        output: "✓ no errors",
        ms: 1500,
      },
    ],
    text: "Done. `backoff.ts` updated (**+4 −2**), typecheck clean.",
  };
}
