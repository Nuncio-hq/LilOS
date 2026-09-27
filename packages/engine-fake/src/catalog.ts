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
}

export const MODEL_CATALOG: FakeModel[] = [
  { id: "fake-small", name: "Fake Small", provider: "fake" },
  { id: "fake-large", name: "Fake Large", provider: "fake" },
  { id: "fake-reasoning", name: "Fake Reasoning", provider: "fake" },
];

export const DEFAULT_MODEL = "fake-large";
