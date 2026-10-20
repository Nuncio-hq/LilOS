import type { AgentDescriptor, DescribeResult } from "@lilos/contracts/engine";
import type { V3Data } from "@lilos/ui";
import { atom, computed, onMount, type ReadableAtom } from "nanostores";
import { engine, relay } from "../lib/runtime";

/* The engine profile behind each agent: its persona text and description,
   which the company record only mirrors (the record has no description at
   all). An agent's page edits them, so the page needs them live: one
   `agents.describe` per profile, once the engine declares the `agents`
   capability. A profile the engine no longer describes has no entry, and the
   page falls back to the company record. */

/** Profile id (as the employee row names it) → what the engine says. */
const described = atom<Record<string, AgentDescriptor>>({});
/** Profiles asked about since the engine last described itself: a failed one
    is not asked again on every employee change, only when the engine does. */
const attempted = new Set<string>();

/** The profile fields the engine lets the app write (the `agents`
    capability's `detail.updatable`, D-#19). */
export function updatableOf(d: DescribeResult | undefined): string[] {
  const u = d?.capabilities.find((c) => c.id === "agents")?.detail?.updatable;
  return Array.isArray(u)
    ? u.filter((x): x is string => typeof x === "string")
    : [];
}

/** The page's words for the engine's: the persona is the instructions. */
const PAGE_FIELD: Record<string, NonNullable<V3Data["agentFields"]>[number]> = {
  soul: "instructions",
  model: "model",
  description: "description",
};

async function load(): Promise<void> {
  const caps = engine.description.get()?.capabilities;
  if (!caps?.some((c) => c.id === "agents")) return;
  const wanted = [
    ...new Set(
      relay.employees.get().flatMap((e) => (e.profile ? [e.profile] : [])),
    ),
  ].filter((p) => !attempted.has(p));
  for (const p of wanted) attempted.add(p);
  const rows = await Promise.all(
    wanted.map((p) => relay.describeAgent(p).catch(() => undefined)),
  );
  const next = { ...described.get() };
  wanted.forEach((p, i) => {
    const row = rows[i];
    if (row) next[p] = row;
  });
  if (wanted.length > 0) described.set(next);
}

/** A profile as the engine now reports it (an `agents.update` answer). */
export function noteProfile(profile: string, agent: AgentDescriptor): void {
  described.set({ ...described.get(), [profile]: agent });
}

/* Reads profiles while something watches (after boot: `relay` and `engine`
   only exist then) and stops with the last watcher. */
onMount(described, () => {
  const sync = () => void load().catch(() => {});
  const stops = [
    relay.employees.listen(sync),
    engine.description.listen(() => {
      attempted.clear();
      sync();
    }),
  ];
  sync();
  return () => {
    for (const stop of stops) stop();
  };
});

export type V3Profiles = {
  byProfile: Record<string, AgentDescriptor>;
  fields: NonNullable<V3Data["agentFields"]>;
};

let store: ReadableAtom<V3Profiles> | undefined;

/** What the data store reads (built on first read, like the other stores
    that need the booted clients). */
export function profileStore(): ReadableAtom<V3Profiles> {
  store ??= computed([engine.description, described], (d, byProfile) => ({
    byProfile,
    fields: updatableOf(d).flatMap((f) =>
      PAGE_FIELD[f] ? [PAGE_FIELD[f]] : [],
    ),
  }));
  return store;
}
