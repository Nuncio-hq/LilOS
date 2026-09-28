import type {
  BackgroundJobRow,
  SubagentRow,
  ThreadDetail,
  ToolStep,
} from "@lilos/ui-native";
import { BUILDER, LILOS } from "./fake-team";

/* Subagents + background work (issue #170) — the mobile twin of
   prototype/web/src/fake-subagents.ts. Builder's "turns lost after sleep"
   thread: turn 1 already fanned out (three subagents, one failed, plus
   Reviewer in its own thread); turn 2 plays live from startLife — two
   subagents and Reviewer run side by side and finish on screen. Mock data,
   not a contract. */

const REVIEWER = { id: "reviewer", name: "Reviewer", tone: "violet" as const };
export const SEQ_THREAD = "s-seq";
export const SLEEP_THREAD = "s-sleep";

const JOBS: BackgroundJobRow[] = [
  {
    id: "j-dev",
    command: "bun run dev",
    status: "running",
    started: "10:41",
    uptime: "14m",
    url: "http://localhost:5173",
    log: "$ bun run dev\nvite v6 ready in 214 ms\n➜  Local:   http://localhost:5173/\n10:48:02 [vite] hmr update /src/App.tsx",
  },
  {
    id: "j-watch",
    command: "bun test --watch apps/harness",
    status: "running",
    started: "10:43",
    uptime: "12m",
    by: "Harness sleep path",
    log: "$ bun test --watch apps/harness\n✓ reconnect › replays afterSequence\n✓ reconnect › backs off to 30s\n\n2 pass · 0 fail · watching…",
  },
  {
    id: "j-build",
    command: "bun run build",
    status: "failed",
    exitCode: 1,
    started: "10:44",
    uptime: "38s",
    log: "$ bun run build\nerror TS2345: apps/harness/src/turns.ts:57\n  Argument of type 'number | undefined' is not assignable to parameter of type 'number'.\nBuild failed in 38s",
  },
];

const step = (id: string, s: Omit<ToolStep, "id">): ToolStep => ({ id, ...s });

const TURN_1: SubagentRow[] = [
  {
    id: "sa-relay",
    name: "Trace relay replay",
    status: "done",
    dur: 41,
    task: "Read apps/relay: how does it replay events after a harness reconnects? Report file:line, no edits.",
    steps: [
      step("1", {
        tool: "search_files",
        arg: "afterSequence",
        output: "3 matches",
      }),
      step("2", {
        tool: "read_file",
        arg: "apps/relay/src/feed.ts",
        output: "212 lines",
      }),
    ],
    result:
      "Relay replays from `afterSequence` correctly (`feed.ts:88`). **The gap is not in the relay.**",
  },
  {
    id: "sa-harness",
    name: "Harness sleep path",
    status: "done",
    dur: 63,
    task: "Find what the harness does with a running turn when the Mac sleeps. Start a test watcher.",
    steps: [
      step("1", {
        tool: "read_file",
        arg: "apps/harness/src/turns.ts",
        output: "140 lines",
      }),
      step("2", {
        tool: "terminal",
        arg: "bun test --watch apps/harness",
        output: "Started in background",
      }),
    ],
    result:
      "`onWake` ends the turn but never resumes from `lastSeq` (`turns.ts:56`), so events sent during sleep are dropped.",
  },
  {
    id: "sa-issues",
    name: "Search Hermes issues",
    status: "failed",
    dur: 12,
    task: "Check hermes-agent issues for known sleep/resume bugs.",
    steps: [
      step("1", {
        tool: "web_search",
        arg: "hermes-agent resume after sleep",
        output: "403 rate limited",
      }),
    ],
    result: "GitHub search was rate-limited (403). Stopped without an answer.",
  },
  {
    id: "sa-review",
    name: "Check envelope seq",
    status: "done",
    dur: 120,
    task: "Confirm envelope seq is monotonic per session.",
    steps: [],
    employee: { ...REVIEWER, threadId: SEQ_THREAD },
    result: "seq is monotonic per session; the contract holds.",
  },
];

export const SUBAGENT_THREADS: ThreadDetail[] = [
  {
    id: SLEEP_THREAD,
    title: "Turns lost after sleep",
    state: "working",
    employee: BUILDER,
    when: "now",
    started: "Today 10:40",
    folder: LILOS,
    branch: {
      name: "lil-9-sleep-replay",
      detail: "new worktree off main · .lilos/wt/lil-9",
    },
    model: "Claude Opus 5.5 · High",
    session: "ses_9d51",
    usage: "91.8k in · 7.4k out · 64k cached",
    jobs: JOBS,
    entries: [
      {
        kind: "user",
        id: "u1",
        time: "10:40",
        text: "Turns get lost when the Mac sleeps. Find out why: relay and harness in parallel, and ask Reviewer to check the envelope.",
      },
      {
        kind: "agent",
        id: "g1",
        time: "10:41",
        thought: 5,
        reasoning:
          "Relay replay and harness wake handling are independent reads: two subagents. The contract question belongs to Reviewer.",
        subagents: TURN_1,
        text: "Found it. The relay is fine; the **harness** drops events: `onWake` never resumes from `lastSeq`. Reviewer confirmed `seq` is monotonic, so resuming is safe.",
        footer: { dur: 128, model: "Opus 5.5", effort: "High" },
      },
      {
        kind: "user",
        id: "u2",
        time: "10:50",
        text: "Good. Write the fix and a test, and have Reviewer look at it.",
      },
      {
        kind: "agent",
        id: "g2",
        time: "10:51",
        thought: 3,
        reasoning:
          "Fix and test touch different files: two subagents in parallel, then Reviewer.",
        live: true,
      },
    ],
  },
  {
    id: SEQ_THREAD,
    title: "Envelope seq (for Builder)",
    state: "done",
    employee: REVIEWER,
    when: "10:44",
    started: "Today 10:42",
    folder: LILOS,
    model: "Claude Opus 5.5 · High",
    session: "ses_rv21",
    entries: [
      {
        kind: "user",
        id: "u1",
        time: "10:42",
        text: "From Builder: confirm envelope seq is monotonic per session.",
      },
      {
        kind: "agent",
        id: "g1",
        time: "10:44",
        thought: 2,
        steps: [
          step("1", {
            tool: "read_file",
            arg: "packages/contracts/src/envelope.ts",
            output: "58 lines",
          }),
          step("2", {
            tool: "search_files",
            arg: "seq =",
            output: "2 matches",
          }),
        ],
        text: "`seq` is assigned in one place (`feed.ts:41`) and only increments. Monotonic per session; the contract holds.",
        footer: { dur: 120, model: "Opus 5.5", effort: "High" },
      },
    ],
  },
];

/* Turn 2's helpers, played by the fake engine. Steps run in order per
   helper; helpers run side by side. An employee helper has no steps here
   (they're in its own thread) — it just works for `wait` ms. */
export type SubagentSpec = Pick<
  SubagentRow,
  "id" | "name" | "task" | "employee"
> & {
  steps: (Omit<ToolStep, "id" | "running"> & { ms?: number })[];
  result: string;
  ends?: "done" | "failed";
  /** Start delay, and (employee helpers) how long they work. */
  delay?: number;
  wait?: number;
};

export const SLEEP_FIX: SubagentSpec[] = [
  {
    id: "sb-fix",
    name: "Fix harness resume",
    task: "Make onWake resume from lastSeq after ending the turn. Minimal change.",
    steps: [
      {
        tool: "read_file",
        arg: "apps/harness/src/turns.ts",
        output: "140 lines",
        ms: 1600,
      },
      {
        tool: "patch",
        arg: "apps/harness/src/turns.ts",
        output: "resume from lastSeq",
        add: 4,
        del: 1,
        ms: 2400,
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
        ms: 1400,
      },
      {
        tool: "write_file",
        arg: "apps/harness/test/sleep.test.ts",
        output: "31 lines",
        add: 31,
        del: 0,
        ms: 2000,
      },
      {
        tool: "terminal",
        arg: "bun test apps/harness/test/sleep.test.ts",
        output: "✓ a turn cut by sleep resumes\n\n3 pass · 0 fail",
        ms: 2200,
      },
    ],
    result: "Regression test added and passing (3 pass).",
  },
  {
    id: "sb-review",
    name: "Review the fix",
    task: "Review Builder's harness resume fix once the test is green.",
    employee: { ...REVIEWER, threadId: SEQ_THREAD },
    steps: [],
    delay: 800,
    wait: 7600,
    result: "Approved: resume uses the monotonic seq.",
  },
];
