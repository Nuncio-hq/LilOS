import type { Msg, Plan, Reply, Step, Thread } from "@lilos/ui"

/* Prototype data + fake engine for a plan (issue #175). Builder's newest session: it read
   the code and proposed a plan; the session waits on Oscar. Approve plays the checklist
   live, Change (Oscar's reply) yields the next version, Reject stops. Real app: Claude Code
   plan mode / Codex plan updates / Hermes todo over the engine protocol. */

export const PLAN_ROOT = "d4"

const V1: Plan = {
  id: "plan-1",
  version: 1,
  goal: "The relay client reconnects on its own after a drop, backing off up to 30s, without losing events.",
  status: "proposed",
  risks: [
    "Reconnect storms if many clients drop at once: adding jitter to the backoff.",
    "Touches the client used by web and mobile; both need a reload test.",
  ],
  steps: [
    { text: "Add a backoff helper (250ms → 30s, with jitter)", files: ["packages/client-runtime/src/backoff.ts"], status: "pending" },
    { text: "Use it in the socket's reconnect loop", files: ["packages/client-runtime/src/socket.ts"], status: "pending" },
    { text: "Resume from the last seq after reconnect", files: ["packages/client-runtime/src/sync.ts"], status: "pending" },
    { text: "Tests: drop → retry → resume, and the 30s cap", files: ["packages/client-runtime/test/reconnect.test.ts"], status: "pending" },
    { text: "Show \"Reconnecting…\" in the status banner", files: ["packages/ui/src/shell/banner.tsx"], status: "pending" },
  ],
}

/* What the employee runs for a step, by the step's first file. */
const WORK_LIST: Step[] = [
  { tool: "write_file", input: { path: "packages/client-runtime/src/backoff.ts" }, output: "24 lines", diff: { path: "packages/client-runtime/src/backoff.ts", status: "added", add: 14, del: 0, patch: "@@ -0,0 +1,14 @@\n+/** 250ms, 500ms, 1s … capped at 30s, ±20% jitter. */\n+export function backoff(attempt: number, cap = 30_000) {\n+  const base = Math.min(cap, 250 * 2 ** attempt)\n+  return base * (0.8 + Math.random() * 0.4)\n+}" } },
  { tool: "patch", input: { path: "packages/client-runtime/src/socket.ts" }, output: "reconnect loop uses backoff()", diff: { path: "packages/client-runtime/src/socket.ts", status: "modified", add: 6, del: 2, patch: "@@ -41,8 +41,12 @@ function onClose() {\n-  setTimeout(connect, 1000)\n+  const wait = backoff(this.attempt++)\n+  this.emit(\"reconnecting\", { in: wait })\n+  setTimeout(connect, wait)" } },
  { tool: "patch", input: { path: "packages/client-runtime/src/sync.ts" }, output: "hello { afterSequence: lastSeq }", diff: { path: "packages/client-runtime/src/sync.ts", status: "modified", add: 3, del: 1, patch: "@@ -18,5 +18,7 @@ export function hello(s: Sync) {\n-  return { kind: \"hello\" }\n+  return { kind: \"hello\", afterSequence: s.lastSeq ?? 0 }" } },
  { tool: "terminal", input: { command: "bun test packages/client-runtime" }, output: "\u001b[32m✓\u001b[0m reconnect › retries with backoff\n\u001b[32m✓\u001b[0m reconnect › resumes after lastSeq\n\u001b[32m✓\u001b[0m reconnect › caps at 30s\n\n 3 pass · 0 fail" },
  { tool: "patch", input: { path: "packages/ui/src/shell/banner.tsx" }, output: "Reconnecting… banner", diff: { path: "packages/ui/src/shell/banner.tsx", status: "modified", add: 4, del: 0, patch: "@@ -12,3 +12,7 @@\n+  if (state === \"reconnecting\")\n+    return <StatusBanner tone=\"amber\">Reconnecting…</StatusBanner>" } },
]

const WORK = new Map(WORK_LIST.map((s) => [String(s.input.path ?? "packages/client-runtime/test/reconnect.test.ts"), s]))
const LOG_RETRY: Step = { tool: "write_file", input: { path: "packages/client-runtime/src/retry-log.ts" }, output: "9 lines", diff: { path: "packages/client-runtime/src/retry-log.ts", status: "added", add: 4, del: 0, patch: "@@ -0,0 +1,4 @@\n+/** One line per retry — the status dialog lists the last few. */\n+export function logRetry(attempt: number, wait: number) {\n+  log.info(\"relay.retry\", { attempt, in: wait })\n+}" } }

export const PLAN_DMS: Record<string, Msg[]> = {
  "dm-builder": [
    {
      kind: "msg", id: PLAN_ROOT, from: "oscar", time: "11:20",
      text: "The phone loses the relay on flaky wifi and never comes back. Make the client reconnect on its own. Plan first, don't edit yet.",
      thread: {
        session: "ses_c7a2", title: "Relay client reconnects on its own", ticket: "LIL-11", branch: "lil-11-reconnect",
        usage: { input: 22400, output: 1800, reasoning: 900, cache: 15000 },
        replies: [
          {
            id: "r-plan-1", from: "builder", time: "11:22", thought: 6, dur: 34,
            reasoning: "Read the socket and sync code before proposing anything. Reconnect lives in client-runtime; the banner is UI. Five steps, tests before the banner.",
            steps: [
              { tool: "read_file", input: { path: "packages/client-runtime/src/socket.ts" }, output: "96 lines" },
              { tool: "read_file", input: { path: "packages/client-runtime/src/sync.ts" }, output: "58 lines" },
              { tool: "search_files", input: { pattern: "setTimeout\\(connect", path: "packages" }, output: "1 match" },
            ],
            text: "Today the socket retries once after 1s and then gives up. Here's how I'd fix it. Nothing is edited until you approve.",
            plan: V1,
          },
        ],
      },
    },
  ],
}

type Edit = (t: Thread) => Thread
const now = () => new Date().toTimeString().slice(0, 5)
const mapPlan = (id: string, fn: (p: Plan) => Plan): Edit => (t) => ({
  ...t,
  replies: t.replies.map((r) => (r.plan?.id === id ? { ...r, plan: fn(r.plan) } : r)),
})
const mapReply = (rid: string, fn: (r: Reply) => Reply): Edit => (t) => ({
  ...t,
  replies: t.replies.map((r) => (r.id === rid ? fn(r) : r)),
})

/* Approve: the plan becomes the checklist; each step goes in progress → done with the
   tool call it needs, then the employee reports. Returns a cancel. */
export function approvePlan(plan: Plan, edit: (fn: Edit) => void, stopped: () => boolean): () => void {
  const planId = plan.id
  const rid = `r-work-${Date.now()}`
  edit((t) => {
    const t2 = mapPlan(planId, (p) => ({ ...p, status: "approved" }))(t)
    return {
      ...t2,
      replies: [
        ...t2.replies,
        { id: rid, from: "builder", time: now(), live: true, phase: "tools", thought: 1, reasoning: "Plan approved. Working through it in order.", text: "", steps: [] },
      ],
    }
  })
  const n = plan.steps.length
  const timers: ReturnType<typeof setTimeout>[] = []
  const at = (ms: number, fn: Edit) =>
    timers.push(setTimeout(() => !stopped() && edit(fn), ms))
  for (let i = 0; i < n; i++) {
    const tool = WORK.get(plan.steps[i].files?.[0] ?? "") ?? LOG_RETRY
    at(600 + i * 2200, (t) => mapReply(rid, (r) => ({ ...r, steps: [...(r.steps ?? []), { ...tool, running: true }] }))(
      mapPlan(planId, (p) => ({ ...p, steps: p.steps.map((s, j) => (j === i ? { ...s, status: "in_progress" } : s)) }))(t)))
    at(600 + i * 2200 + 1600, (t) => mapReply(rid, (r) => ({ ...r, steps: r.steps?.map((s, j) => (j === i ? { ...s, running: false } : s)) }))(
      mapPlan(planId, (p) => ({ ...p, steps: p.steps.map((s, j) => (j === i ? { ...s, status: "completed" } : s)) }))(t)))
  }
  at(600 + n * 2200, mapReply(rid, (r) => ({
    ...r, live: false, phase: "done", dur: Math.round((600 + n * 2200) / 1000),
    text: `All ${n} steps done on \`lil-11-reconnect\`: the client backs off up to 30s with jitter and resumes from the last seq. Tests pass (3). The banner says **Reconnecting…** while it waits.`,
  })))
  const guard = setInterval(() => {
    if (!stopped()) return
    timers.forEach(clearTimeout)
    clearInterval(guard)
    edit((t) => mapReply(rid, (r) => ({ ...r, live: false, phase: "stopped", steps: r.steps?.map((s) => ({ ...s, running: false })) }))(
      mapPlan(planId, (p) => ({ ...p, steps: p.steps.map((s) => (s.status === "in_progress" ? { ...s, status: "cancelled" } : s)) }))(t)))
  }, 300)
  timers.push(setTimeout(() => clearInterval(guard), 600 + n * 2200 + 200))
  return () => {
    timers.forEach(clearTimeout)
    clearInterval(guard)
  }
}

/* Reject: nothing was edited; the employee says so. */
export const rejectPlan = (planId: string): Edit => (t) => ({
  ...mapPlan(planId, (p) => ({ ...p, status: "rejected" }))(t),
  replies: [
    ...mapPlan(planId, (p) => ({ ...p, status: "rejected" }))(t).replies,
    { from: "builder", time: now(), text: "OK, I won't start. Nothing was edited. The plan stays here if you change your mind." },
  ],
})

/** The plan waiting on you in this thread, if any — a reply to it is a change request. */
export const pendingPlan = (t?: Thread) => t?.replies.find((r) => r.plan?.status === "proposed")?.plan

/* Change: Oscar's reply replaces the waiting plan with the next version, his ask folded in
   as a step (a real engine rewrites the whole plan). */
export function revisePlan(planId: string, ask: string): Edit {
  return (t) => {
    const old = t.replies.find((r) => r.plan?.id === planId)?.plan
    if (!old) return t
    const change = ask.replace(/^\s*change the plan:\s*/i, "").trim() || "your change"
    const next: Plan = {
      ...old,
      id: `plan-${old.version + 1}`,
      version: old.version + 1,
      status: "proposed",
      steps: [
        ...old.steps.slice(0, -1).map((s) => ({ ...s, status: "pending" as const })),
        { text: `Your change: ${change}`, files: ["packages/client-runtime/src/retry-log.ts"], status: "pending" },
        { ...old.steps[old.steps.length - 1], status: "pending" },
      ],
    }
    const t2 = mapPlan(planId, (p) => ({ ...p, status: "replaced" }))(t)
    return {
      ...t2,
      replies: [
        ...t2.replies,
        { from: "builder", time: now(), thought: 2, dur: 9, reasoning: "Fold Oscar's change into the plan; everything else stays.", text: "Updated the plan with your change. Still nothing edited.", plan: next },
      ],
    }
  }
}
