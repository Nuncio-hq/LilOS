import type { AgentDescriptor, DescribeResult } from "@lilos/contracts/engine";
import type { V3Data } from "@lilos/ui";
import { atom, computed, onMount, type ReadableAtom } from "nanostores";
import { engine, relay } from "../lib/runtime";
import { isDefaultRuntime, runtimeLive } from "./runtime-ids";

/* The engine profile behind each agent: its persona text and description,
   which the company record only mirrors (the record has no description at
   all). An agent's page edits them, so the page needs them live: one
   `agents.describe` per profile, routed to the runtime that owns it
   (D-#761) — describing an ACP agent on Hermes answered the wrong engine,
   the original bug in #872. A profile the owning engine can't or won't
   describe has no entry, and the page falls back to the company record. */

/** Profiles are engine-side ids — unique only per runtime, so the store's
    key carries it: `${runtime}::${profile}`. The default runtime keys as
    `::id` ALWAYS — a record stamped `runtime: "hermes"` (the default id)
    and one left unstamped name the same profile (#872: the write path
    keyed `::id` while the read looked under `hermes::id`, so a saved
    description appeared to revert). */
export const profileKey = (
  runtime: string | undefined,
  profile: string,
): string => {
  return `${isDefaultRuntime(runtime) ? "" : runtime}::${profile}`;
};

/** Key (as `profileKey` makes it) → what the owning engine says. */
const described = atom<Record<string, AgentDescriptor>>({});
/** Profiles asked about at a status signature: the same key is re-asked
   when the runtime's own verdict changes (a failed engine coming up), not
   on every employee/status tick. */
const attempted = new Map<string, string>();
/* D-#899: runtimes an open screen asked for (`openRuntimeScreen` marks
   them here) — their profiles describe even while the adapter sleeps. */
const pending = new Set<string>();

/** D-#899: a screen showing this runtime's agent asks its profile even
   while the adapter sleeps — the describe lazy-starts it and lands
   `agentsUpdatable`, the page's editable fields. */
export function openRuntimeProfile(runtime: string): void {
  if (isDefaultRuntime(runtime) || pending.has(runtime)) return;
  pending.add(runtime);
  void load().catch(() => {});
}

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
  const wanted = [
    ...new Map(
      relay.employees.get().flatMap((e) => {
        if (!e.profile) return [];
        const runtime = e.runtime;
        const row = runtime ? rows.find((r) => r.id === runtime) : undefined;
        const isDefault = isDefaultRuntime(runtime);
        if (isDefault && !hasAgents) return [];
        if (row?.available === false) return [];
        /* A coding runtime answers only when it is already up — a plain
           read must never npm-install an engine (D-#866); the record's
           own fields fill the page until real work starts it. An open
           screen is the exception (D-#899): it marked the runtime
           pending, and this describe is what lazy-starts the adapter. */
        if (!isDefault && !runtimeLive(runtime) && !pending.has(runtime ?? ""))
          return [];
        const key = profileKey(runtime, e.profile);
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
