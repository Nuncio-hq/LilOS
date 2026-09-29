/**
 * The fake engine's "profile store" — deterministic seed data for the
 * `agents` and `models` capabilities. `agents.create` appends to the agents
 * map at runtime (in-memory only, per FakeEngine instance); nothing is ever
 * removed.
 */
export interface FakeAgent {
  id: string;
  name: string;
  description: string;
  model: string;
  skillCount: number;
  soul: string;
}

export const SEED_AGENTS: FakeAgent[] = [
  {
    id: "default",
    name: "Default",
    description: "The stock employee profile: general builder on fake-large.",
    model: "fake-large",
    skillCount: 9,
    soul: "You are the default employee. Read first, show your work, keep diffs small.",
  },
  {
    id: "builder",
    name: "Builder",
    description: "General builder: edits, tests, commits on its own branch.",
    model: "fake-large",
    skillCount: 9,
    soul: "You are Builder. Own the branch, keep diffs small, show your work.",
  },
  {
    id: "marketer",
    name: "Marketer",
    description: "Positioning and launch copy in Oscar's voice.",
    model: "fake-small",
    skillCount: 4,
    soul: "You are Marketer. Plain, concrete, no hype. Write like Oscar.",
  },
  {
    id: "reviewer",
    name: "Reviewer",
    description: "Read-only code review on main.",
    model: "fake-small",
    skillCount: 6,
    soul: "You are Reviewer. Read the diff first; say when it is wrong.",
  },
];

export interface FakeModel {
  id: string;
  name: string;
  provider?: string;
  /** Ordered low→high reasoning levels this model supports (absent = no dial). */
  efforts?: string[];
  defaultEffort?: string;
  /** The model has a fast/priority tier. */
  fast?: boolean;
}

/** The full ladder an engine reports when a model reasons but has no
    per-model list. */
export const FAKE_EFFORT_LADDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const MODEL_CATALOG: FakeModel[] = [
  { id: "fake-small", name: "Fake Small", provider: "fake" },
  {
    id: "fake-large",
    name: "Fake Large",
    provider: "fake",
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    fast: true,
  },
  {
    id: "fake-reasoning",
    name: "Fake Reasoning",
    provider: "fake",
    efforts: [...FAKE_EFFORT_LADDER],
    defaultEffort: "medium",
    fast: true,
  },
  /* A "/" inside the id is legal — a model is {provider?, id}, never a
     joined "provider/model" string (#92 AC-8). */
  {
    id: "fake/opus-2",
    name: "Fake Opus 2",
    provider: "fake",
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
];

/** Surfaced only by `models.list {refresh:true}` — the "new model appears
    without a restart" fixture (#92 AC-6). Joins the engine's accepted set once
    a refresh has been served — `session.setModel` refuses it before that,
    the same gate a real adapter applies (#140 AC-2). A session may still RUN
    on it earlier (the account-gated case: the session's own pick can be
    absent from the catalog, #140 AC-1). */
export const REFRESH_MODEL: FakeModel = {
  id: "fake-fresh",
  name: "Fake Fresh",
  provider: "fake",
  efforts: ["low", "high"],
  defaultEffort: "low",
};

export const DEFAULT_MODEL = "fake-large";
