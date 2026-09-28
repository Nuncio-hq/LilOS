import type { PlanRow, ThreadDetail, ToolStep } from "@lilos/ui-native";
import { BUILDER, LILOS } from "./fake-team";

/* A plan waiting on you (issue #175) — the mobile twin of
   prototype/web/src/fake-plan.ts. Builder read the code and proposed a plan;
   nothing is edited until you decide. The fake engine plays the rest. Mock
   data, not a contract. */

export const PLAN_THREAD = "s-plan";

export const PLAN_V1: PlanRow = {
  id: "plan-1",
  version: 1,
  goal: "The relay client reconnects on its own after a drop, backing off up to 30s, without losing events.",
  status: "proposed",
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

/* The tool call each step runs, by the step's first file; anything else is an edit of it. */
const WORK: Record<string, Omit<ToolStep, "id" | "running">> = {
  "packages/client-runtime/src/backoff.ts": {
    tool: "write_file",
    arg: "packages/client-runtime/src/backoff.ts",
    output: "24 lines",
    add: 14,
    del: 0,
  },
  "packages/client-runtime/src/socket.ts": {
    tool: "patch",
    arg: "packages/client-runtime/src/socket.ts",
    output: "reconnect uses backoff()",
    add: 6,
    del: 2,
  },
  "packages/client-runtime/src/sync.ts": {
    tool: "patch",
    arg: "packages/client-runtime/src/sync.ts",
    output: "hello { afterSequence }",
    add: 3,
    del: 1,
  },
  "packages/client-runtime/test/reconnect.test.ts": {
    tool: "terminal",
    arg: "bun test packages/client-runtime",
    output:
      "✓ retries with backoff\n✓ resumes after lastSeq\n✓ caps at 30s\n\n3 pass · 0 fail",
  },
  "packages/ui/src/shell/banner.tsx": {
    tool: "patch",
    arg: "packages/ui/src/shell/banner.tsx",
    output: "Reconnecting… banner",
    add: 4,
    del: 0,
  },
};
export const workFor = (file?: string): Omit<ToolStep, "id" | "running"> =>
  (file && WORK[file]) || {
    tool: "write_file",
    arg: file ?? "packages/client-runtime/src/retry-log.ts",
    output: "9 lines",
    add: 4,
    del: 0,
  };

/** The next version with your ask folded in as a step (a real engine rewrites it). */
export function nextVersion(p: PlanRow, ask: string): PlanRow {
  const change =
    ask.replace(/^\s*change the plan:\s*/i, "").trim() || "your change";
  return {
    ...p,
    id: `plan-${p.version + 1}`,
    version: p.version + 1,
    status: "proposed",
    steps: [
      ...p.steps
        .slice(0, -1)
        .map((s) => ({ ...s, status: "pending" as const })),
      {
        text: `Your change: ${change}`,
        files: ["packages/client-runtime/src/retry-log.ts"],
        status: "pending",
      },
      { ...p.steps[p.steps.length - 1], status: "pending" },
    ],
  };
}

export const PLAN_THREADS: ThreadDetail[] = [
  {
    id: PLAN_THREAD,
    title: "Reconnect on its own",
    state: "needs-you",
    employee: BUILDER,
    when: "now",
    started: "Today 11:20",
    folder: LILOS,
    branch: {
      name: "lil-11-reconnect",
      detail: "new worktree off main · .lilos/wt/lil-11",
    },
    model: "Claude Opus 5.5 · High",
    session: "ses_c7a2",
    usage: "22.4k in · 1.8k out · 15k cached",
    entries: [
      {
        kind: "user",
        id: "u1",
        time: "11:20",
        text: "The phone loses the relay on flaky wifi and never comes back. Make the client reconnect on its own. Plan first, don't edit yet.",
      },
      {
        kind: "agent",
        id: "g1",
        time: "11:22",
        thought: 6,
        reasoning:
          "Read socket and sync before proposing anything. Five steps, tests before the banner.",
        steps: [
          {
            id: "1",
            tool: "read_file",
            arg: "packages/client-runtime/src/socket.ts",
            output: "96 lines",
          },
          {
            id: "2",
            tool: "read_file",
            arg: "packages/client-runtime/src/sync.ts",
            output: "58 lines",
          },
          {
            id: "3",
            tool: "search_files",
            arg: "setTimeout(connect",
            output: "1 match",
          },
        ],
        text: "Today the socket retries once after 1s and gives up. Here's my plan. Nothing is edited until you approve.",
        plan: PLAN_V1,
        footer: { dur: 34, model: "Opus 5.5", effort: "High" },
      },
    ],
  },
];
