import type { AgentDescriptor, DescribeResult } from "@lilos/contracts/engine";
import type { V3Data } from "@lilos/ui";
import { atom, computed, onMount, type ReadableAtom } from "nanostores";
import { engine, relay } from "../lib/runtime";

/* The engine profile behind each agent: its persona text and description,
   which the company record only mirrors (the record has no description at
   all). An agent's page edits them, so the page needs them live: one
   `agents.describe` per profile, routed to the runtime that owns it
   (D-#761) — describing an ACP agent on Hermes answered the wrong engine,
   the original bug in #872. A profile the owning engine can't or won't
   describe has no entry, and the page falls back to the company record. */

/** Profiles are engine-side ids — unique only per runtime, so the store's
    key carries it: `${runtime}::${profile}` (default runtime = `::id`). */
export const profileKey = (
  runtime: string | undefined,
  profile: string,
): string => `${runtime ?? ""}::${profile}`;

/** Key (as `profileKey` makes it) → what the owning engine says. */
const described = atom<Record<string, AgentDescriptor>>({});
/** Profiles asked about at a status signature: the same key is re-asked
   when the runtime's own verdict changes (a failed engine coming up), not
   on every employee/status tick. */
const attempted = new Map<string, string>();

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
  /* The default engine must declare `agents` for its profiles; a coding
     runtime is asked directly — its own describe is the only way to learn
     it (and it lazy-starts, so asking is what brings it up). */
  const hasAgents =
    engine.description.get()?.capabilities.some((c) => c.id === "agents") ===
    true;
  const rows = relay.status.get()?.result?.runtimes ?? [];
  const defaultId = rows[0]?.id;
  const wanted = [
    ...new Map(
      relay.employees.get().flatMap((e) => {
        if (!e.profile) return [];
        const runtime = e.runtime;
        const row = runtime ? rows.find((r) => r.id === runtime) : undefined;
        const isDefault = !runtime || runtime === defaultId;
        if (isDefault && !hasAgents) return [];
        if (row?.available === false) return [];
        const key = profileKey(runtime, e.profile);
        /* A re-ask is owed only when the runtime's verdict moved (a row
           that never ran still answers — asking is how it starts). */
        const sig = row ? `${row.available}:${row.state ?? ""}` : "";
        return [[key, { key, profile: e.profile, runtime, sig }] as const];
      }),
    ).values(),
  ].filter((w) => attempted.get(w.key) !== w.sig);
  for (const w of wanted) attempted.set(w.key, w.sig);
  const rows1 = await Promise.all(
    wanted.map((w) =>
      relay.describeAgent(w.profile, w.runtime).catch(() => undefined),
    ),
  );
  const next = { ...described.get() };
  wanted.forEach((w, i) => {
    const row = rows1[i];
    if (row) next[w.key] = row;
  });
  if (wanted.length > 0) described.set(next);
}

/** A profile as its engine now reports it (an `agents.update` answer). */
export function noteProfile(
  profile: string,
  runtime: string | undefined,
  agent: AgentDescriptor,
): void {
  described.set({ ...described.get(), [profileKey(runtime, profile)]: agent });
}

/* Reads profiles while something watches (after boot: `relay` and `engine`
   only exist then) and stops with the last watcher. Status listens too: a
   runtime's row changing re-signs its asks. */
onMount(described, () => {
  const sync = () => void load().catch(() => {});
  const stops = [
    relay.employees.listen(sync),
    relay.status.listen(sync),
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
