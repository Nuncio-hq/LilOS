import type {
  AppChannel,
  Employee,
  MacFolderEntry,
  MacFoundRepo,
  ProfileSettings,
} from "@lilos/contracts/app";
import type { Capability, ModelOption } from "@lilos/contracts/engine";
import type { ForgePrListItem } from "@lilos/contracts/host";

/* The demo company (#168): the prototype's fake-team content as WIRE data —
   the shapes a real relay serves, so the app's screens read it through the
   client interface exactly like production. Deterministic: every id is
   fixed; timestamps are `now` offsets baked at DemoClient construction. */

const DEMO_TEAM = [
  {
    id: "builder",
    name: "Builder",
    role: "Engineer",
    status: "busy",
    profile: "builder",
    model: "claude-opus-5-5",
    now: "Wiring the relay handshake",
  },
  {
    id: "reviewer",
    name: "Reviewer",
    role: "Code review",
    status: "online",
    profile: "reviewer",
    model: "claude-sonnet-5",
    now: "Reviewed #93",
  },
  {
    id: "marketer",
    name: "Marketer",
    role: "Growth",
    status: "online",
    profile: "marketer",
    model: "claude-sonnet-5",
    now: "Drafted the launch thread",
  },
  {
    id: "default",
    name: "Default",
    role: "Generalist",
    status: "online",
    profile: "default",
    model: "qwen3.8-flash-next",
    now: "Sorted your inbox",
  },
] as const;

export function demoEmployees(createdAt: number): Employee[] {
  return DEMO_TEAM.map((e) => ({
    ...e,
    status: e.status as Employee["status"],
    instructions: "",
    respondTo: "anyone",
    createdAt,
  }));
}

export function demoChannels(
  createdAt: number,
  lastSeqs: Record<string, number>,
): AppChannel[] {
  return DEMO_TEAM.map((e) => ({
    id: `ch-${e.id}`,
    kind: "dm",
    employeeId: e.id,
    lastSeq: lastSeqs[`ch-${e.id}`] ?? 0,
    createdAt,
  }));
}

export const DEMO_PROFILE: ProfileSettings = {
  userName: "Oscar",
  companyName: "LilOS Demo",
};

/* ── The Mac's folders (prototype FOLDERS + fake-mac-fs) ─────────────────── */

export const DEMO_RECENTS = [
  "~/Desktop/Oscar/LilOS",
  "~/Desktop/Oscar/SamProjects/QRit",
  "~/Documents/Notes",
];

export type DemoFolderDetail = {
  missing: boolean;
  isRepo: boolean;
  root?: string;
  current?: string | null;
  branches: string[];
  workstreams: { branch: string; path: string; from?: string }[];
};

export const DEMO_FOLDER_DETAILS: Record<string, DemoFolderDetail> = {
  "~/Desktop/Oscar/LilOS": {
    missing: false,
    isRepo: true,
    root: "~/Desktop/Oscar/LilOS",
    current: "main",
    branches: ["main", "release/0.1"],
    workstreams: [
      {
        branch: "feat/relay-reconnect",
        path: "~/Desktop/Oscar/LilOS/.lilos/wt/lil-9",
        from: "main",
      },
      {
        branch: "lil-3-monorepo",
        path: "~/Desktop/Oscar/LilOS/.lilos/wt/lil-3",
        from: "main",
      },
    ],
  },
  "~/Desktop/Oscar/SamProjects/QRit": {
    missing: false,
    isRepo: true,
    root: "~/Desktop/Oscar/SamProjects/QRit",
    current: "main",
    branches: ["main", "develop"],
    workstreams: [
      {
        branch: "qr-7-paywall",
        path: "~/Desktop/Oscar/SamProjects/QRit/.lilos/wt/qr-7",
        from: "develop",
      },
    ],
  },
  "~/Documents/Notes": {
    missing: false,
    isRepo: false,
    branches: [],
    workstreams: [],
  },
};

/* One-level children + repo markers — the fake-mac-fs tree verbatim. */
const FS: Record<string, { branch?: string; children?: string[] }> = {
  "~": { children: ["Desktop", "Developer", "Documents"] },
  "~/Desktop": { children: ["Oscar"] },
  "~/Desktop/Oscar": {
    children: ["LilOS", "crew", "ProviderAuthForHarness", "SamProjects"],
  },
  "~/Desktop/Oscar/LilOS": {
    branch: "main",
    children: ["apps", "docs", "packages"],
  },
  "~/Desktop/Oscar/LilOS/apps": { children: [] },
  "~/Desktop/Oscar/LilOS/docs": { children: [] },
  "~/Desktop/Oscar/LilOS/packages": { children: [] },
  "~/Desktop/Oscar/crew": { branch: "main", children: ["src", "docs"] },
  "~/Desktop/Oscar/ProviderAuthForHarness": { children: ["Devin"] },
  "~/Desktop/Oscar/ProviderAuthForHarness/Devin": { children: ["Hermes"] },
  "~/Desktop/Oscar/ProviderAuthForHarness/Devin/Hermes": {
    children: ["agentauth"],
  },
  "~/Desktop/Oscar/ProviderAuthForHarness/Devin/Hermes/agentauth": {
    branch: "main",
    children: ["src"],
  },
  "~/Desktop/Oscar/SamProjects": { children: ["QRit", "qrit-landing"] },
  "~/Desktop/Oscar/SamProjects/QRit": {
    branch: "develop",
    children: ["ios", "web"],
  },
  "~/Desktop/Oscar/SamProjects/qrit-landing": {
    branch: "develop",
    children: ["src"],
  },
  "~/Developer": { children: ["hermes-agent", "scratch"] },
  "~/Developer/hermes-agent": {
    branch: "main",
    children: ["tui_gateway", "hermes_cli"],
  },
  "~/Developer/scratch": { children: [] },
  "~/Documents": { children: ["Notes", "Invoices"] },
  "~/Documents/Notes": { children: [] },
  "~/Documents/Invoices": { children: [] },
};

export function demoBrowse(path: string): {
  path: string;
  branch?: string;
  folders: MacFolderEntry[];
} {
  const d = FS[path];
  return {
    path,
    ...(d?.branch ? { branch: d.branch } : {}),
    folders: (d?.children ?? []).map((name) => {
      const p = `${path}/${name}`;
      return {
        name,
        path: p,
        ...(FS[p]?.branch ? { branch: FS[p].branch } : {}),
      };
    }),
  };
}

export const DEMO_FOUND: MacFoundRepo[] = [
  "~/Desktop/Oscar/crew",
  "~/Desktop/Oscar/SamProjects/qrit-landing",
  "~/Developer/hermes-agent",
].map((path) => ({
  path,
  ...(FS[path]?.branch ? { branch: FS[path].branch } : {}),
}));

/* ── Model catalog (prototype MODELS/PROVIDERS) ──────────────────────────── */

const LADDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const CODEX = ["low", "medium", "high", "xhigh", "max"];

export const DEMO_MODELS: ModelOption[] = [
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    provider: "anthropic-cliproxy",
    efforts: LADDER,
    defaultEffort: "high",
    fast: true,
    contextWindow: 200_000,
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    provider: "anthropic-cliproxy",
    efforts: LADDER,
    defaultEffort: "medium",
    contextWindow: 200_000,
  },
  {
    id: "claude-3-5-haiku",
    name: "Claude 3.5 Haiku",
    provider: "anthropic-cliproxy",
    contextWindow: 200_000,
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    provider: "openai-codex",
    efforts: CODEX,
    defaultEffort: "medium",
    fast: true,
    contextWindow: 272_000,
  },
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    provider: "openai-codex",
    efforts: ["none", ...CODEX],
    defaultEffort: "low",
    fast: true,
    contextWindow: 128_000,
  },
  {
    id: "grok-4.6",
    name: "Grok 4.6",
    provider: "xai-oauth",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    fast: true,
    contextWindow: 256_000,
  },
  {
    id: "qwen3.8-flash-next",
    name: "Qwen 3.8 Flash-Next",
    provider: "hpc",
    efforts: LADDER,
    defaultEffort: "medium",
    contextWindow: 131_000,
  },
];

export const DEMO_PROVIDERS = [
  { id: "hpc", name: "HPC" },
  { id: "anthropic-cliproxy", name: "Anthropic – CLIProxyAPI" },
  { id: "openai-codex", name: "ChatGPT or Codex Subscription" },
  { id: "xai-oauth", name: "xAI Grok OAuth (SuperGrok / Premium+)" },
];

export const DEMO_DEFAULT_MODEL = "claude-opus-5-5";
export const DEMO_DEFAULT_PROVIDER = "anthropic-cliproxy";

export const DEMO_CAPABILITIES: Capability[] = [
  { id: "models", name: "Model picker" },
  { id: "plan", name: "Plan approval" },
  { id: "subagents", name: "Subagents" },
  { id: "background_jobs", name: "Background jobs" },
  { id: "usage", name: "Usage" },
  { id: "session_meta", name: "Thread metadata" },
];

/* ── PRs the conversations carry (thread rows + PrCards) ─────────────────── */

const GH = "https://github.com/Nuncio-hq/LilOS/pull";

function demoPr(
  number: number,
  title: string,
  opts: {
    state?: "open" | "merged" | "closed";
    draft?: boolean;
    checks?: ForgePrListItem["checks"];
    openedAt?: string;
  },
): ForgePrListItem {
  return {
    number,
    url: `${GH}/${number}`,
    repo: "Nuncio-hq/LilOS",
    title,
    state: opts.state ?? "open",
    draft: opts.draft ?? false,
    head: `demo/pr-${number}`,
    base: "main",
    openedAt: opts.openedAt ?? "2026-09-28T15:02:00Z",
    checks: opts.checks ?? "none",
  };
}

export const DEMO_PRS: Record<string, ForgePrListItem[]> = {
  "s-pair": [
    demoPr(91, "Pair phone: QR + manual code", { state: "merged" }),
    demoPr(93, "Pair phone: bigger mono code", { state: "merged" }),
    demoPr(95, "Pair phone: copy tweaks", { checks: "passing" }),
  ],
  "s-relay": [
    demoPr(96, "Relay: replay the gap on reconnect", {
      draft: true,
      checks: "failing",
    }),
  ],
  "s-flake": [
    demoPr(86, "DM feed: avatar above the name row", { checks: "pending" }),
  ],
};
