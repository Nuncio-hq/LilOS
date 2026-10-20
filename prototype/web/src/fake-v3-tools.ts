import type { V3Data, V3Workbench } from "@lilos/ui"

/* ?v3 mock: the tools around the company. Each thread's Workbench, the
   LilOS Browser's tabs, schedules, the paired phone and Settings. Same Monday
   at 12:04 as fake-v3.ts, so every screen agrees. */

const LIL81: V3Workbench = {
  diffs: [
    {
      path: "packages/ui/src/workbench/workbench.tsx",
      add: 6,
      del: 1,
      lines: [
        { kind: "ctx", text: "useEffect(() => {" },
        { kind: "del", text: "  if (cache.ready) restoreScroll(saved)" },
        { kind: "add", text: "  if (!cache.ready) return" },
        { kind: "add", text: "  // The list paints a frame after the cache hydrates." },
        { kind: "add", text: "  const id = requestAnimationFrame(() =>" },
        { kind: "add", text: "    requestAnimationFrame(() => restoreScroll(saved)))" },
        { kind: "add", text: "  return () => cancelAnimationFrame(id)" },
        { kind: "ctx", text: "}, [cache.ready])" },
      ],
    },
    {
      path: "packages/ui/src/lib/wb-probe-cache.ts",
      add: 12,
      del: 3,
      lines: [
        { kind: "ctx", text: "export function probeCache(key: string) {" },
        { kind: "del", text: "  return cache.get(key)" },
        { kind: "add", text: "  const hit = cache.get(key)" },
        { kind: "add", text: "  if (hit) hit.readyAt ??= performance.now()" },
        { kind: "add", text: "  return hit" },
        { kind: "ctx", text: "}" },
      ],
    },
  ],
  files: [
    "e2e/",
    "e2e/ac-544-workbench-reopen.spec.ts",
    "packages/",
    "packages/ui/",
    "packages/ui/src/",
    "packages/ui/src/lib/",
    "packages/ui/src/lib/wb-probe-cache.ts",
    "packages/ui/src/workbench/",
    "packages/ui/src/workbench/workbench.tsx",
    "packages/ui/src/workbench/diff-view.tsx",
    "package.json",
    "README.md",
  ],
  fileText: {
    "e2e/ac-544-workbench-reopen.spec.ts":
      'test("AC-6 restores the scroll position", async ({ page }) => {\n  await openBigRepo(page)\n  await page.mouse.wheel(0, 1840)\n  await reopenWorkbench(page)\n  await expect(list(page)).toHaveScrollTop(1840)\n})',
    "packages/ui/src/lib/wb-probe-cache.ts":
      "const cache = new Map<string, Probe>()\n\nexport function probeCache(key: string) {\n  const hit = cache.get(key)\n  if (hit) hit.readyAt ??= performance.now()\n  return hit\n}",
    "README.md": "# LilOS\n\nA company OS where the employees are AI agents.\n\n    bun install\n    bun run prototype:dev",
  },
  terminal: [
    { cmd: "bun run typecheck", lines: ["$ tsc -b", "Done in 18.2s"] },
    {
      cmd: "playwright test ac-544-workbench-reopen.spec.ts --repeat-each=15",
      lines: [
        "Running 30 tests using 4 workers",
        "✓ ac-544 › reopens the cached workbench (run 1)",
        "✓ ac-544 › AC-6 restores the scroll position (run 1)",
        "✓ ac-544 › reopens the cached workbench (run 2)",
        "✓ ac-544 › AC-6 restores the scroll position (run 2)",
        "  11 passed · running 12 of 15…",
      ],
      running: true,
    },
  ],
  preview: { url: "http://localhost:5173/?v2", title: "LilOS prototype" },
  jobs: [{ cmd: "bun run prototype:dev", state: "running", tail: "VITE ready in 240 ms · http://localhost:5173/" }],
}

const HB12_BUILD: V3Workbench = {
  diffs: [
    {
      path: "src/paywall/variants.ts",
      add: 142,
      del: 20,
      lines: [
        { kind: "add", text: "export const VARIANTS = {" },
        { kind: "add", text: '  a: { headline: "Unlock every entry", cta: "Start free trial" },' },
        { kind: "add", text: '  b: { headline: "Write it before you forget it", cta: "Try 7 days free" },' },
        { kind: "add", text: "} as const" },
      ],
    },
    {
      path: "src/paywall/Paywall.tsx",
      add: 58,
      del: 18,
      lines: [
        { kind: "del", text: "  <h1>Unlock every entry</h1>" },
        { kind: "add", text: "  <h1>{VARIANTS[variant].headline}</h1>" },
      ],
    },
  ],
  files: ["src/", "src/paywall/", "src/paywall/variants.ts", "src/paywall/Paywall.tsx", "src/paywall/copy.ts", "app.json"],
  fileText: {
    "src/paywall/copy.ts": 'export const PRICE_LINE = "$4.99 a month after the trial"',
  },
  terminal: [
    { cmd: "bun test src/paywall", lines: ["14 pass", "0 fail", "Ran 14 tests in 20.1s"] },
    { cmd: "gh pr create --fill", lines: ["https://github.com/heardback/app/pull/66"] },
  ],
  pr: { num: 66, title: "Paywall copy A/B test", state: "open", checks: "passing" },
  jobs: [],
}

/** Workbench per thread id. */
export const WORKBENCHES: Record<string, V3Workbench> = {
  "t-lil81": LIL81,
  "t-hb12-build": HB12_BUILD,
  "t-hb12-ceo": { ...HB12_BUILD, terminal: [{ cmd: "gh pr view 66 --json files", lines: ["3 files changed"] }] },
}

export const SCHEDULES: V3Data["schedules"] = [
  {
    id: "s-brief",
    agentId: "ceo",
    title: "Morning update",
    prompt: "Write Oscar a short update: what moved since yesterday, what is stuck, what needs him.",
    when: { kind: "weekdays", time: "09:00" },
    next: "Tomorrow 09:00",
    last: { at: "Today 09:00", result: "finished", threadId: "t-hb12-plan" },
  },
  {
    id: "s-posts",
    agentId: "marketer",
    projectId: "heardback",
    title: "Post the day's hook on X",
    prompt: "Pick the best unused hook from the sheet and draft today's X post. Ask before posting.",
    when: { kind: "daily", time: "09:30" },
    next: "Tomorrow 09:30",
    last: { at: "Today 09:30", result: "finished" },
  },
  {
    id: "s-onboarding",
    agentId: "designer",
    projectId: "qrit",
    title: "Onboarding copy pass",
    prompt: "QR-7: rewrite the onboarding copy in our voice. Two options per screen.",
    when: { kind: "once", time: "14:00", date: "2026-10-19" },
    next: "Today 14:00",
  },
  {
    id: "s-flakes",
    agentId: "builder",
    projectId: "lilos",
    title: "Nightly flaky-test sweep",
    prompt: "Run the e2e suite three times and open a ticket for any test that fails once.",
    when: { kind: "daily", time: "02:00" },
    next: "Tonight 02:00",
    paused: true,
    last: { at: "Sat 02:00", result: "failed" },
  },
]

export const BROWSER: V3Data["browser"] = {
  tabs: [
    {
      id: "b-1",
      title: "HeardBack · App Store Connect",
      url: "https://appstoreconnect.apple.com/apps/heardback",
      by: "you",
      page: ["HeardBack · iOS App", "Version 2.4 · Ready for Sale", "Ratings: 4.7 · 1,204 ratings"],
    },
    {
      id: "b-2",
      title: "journaling creators 5k–50k · Search",
      url: "https://search.example/?q=journaling+creators+5k-50k",
      by: "scout",
      threadId: "t-hb14",
      doing: "Searching the same query again",
      page: ["About 1,240 results", "Top journaling creators to follow in 2026", "12 journaling YouTubers worth your time"],
    },
    {
      id: "b-3",
      title: "Meta Ads Manager",
      url: "https://business.facebook.com/adsmanager",
      by: "marketer",
      threadId: "t-hb11",
      doing: "Waiting for your approval before launching",
      page: ["Campaign: HB hooks test · Draft", "3 ad sets · $40 total · 3 days", "Not published"],
    },
  ],
  bookmarks: [
    { title: "App Store Connect", url: "https://appstoreconnect.apple.com" },
    { title: "Meta Ads Manager", url: "https://business.facebook.com/adsmanager" },
    { title: "LilOS on GitHub", url: "https://github.com/Nuncio-hq/LilOS" },
  ],
}

export const DEVICES: V3Data["devices"] = [{ id: "d-1", name: "iPhone", model: "iPhone 17 Pro", lastSeen: "4m ago" }]

export const SETTINGS: V3Data["settings"] = {
  push: { needsYou: true, finished: false, stuck: true, failed: true },
  approvals: "ask",
  editor: "Cursor",
  models: [
    { id: "opus", label: "Opus 5.5", on: true },
    { id: "sonnet", label: "Sonnet 5", on: true },
    { id: "haiku", label: "Haiku 5", on: true },
    { id: "gpt", label: "GPT-6", on: false },
  ],
  engine: { name: "Hermes", version: "0.14.2", state: "ok", path: "~/.hermes/bin/hermes" },
}
