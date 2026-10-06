import {
  EngineClient,
  RelayClient,
  type SessionFeedState,
  type SessionModel,
  SessionReducer,
} from "@lilos/client-runtime";
import type {
  Ask,
  EngineHostStatus,
  SystemStatusResult,
  WelcomeResult,
  WorkbenchOpenTarget,
} from "@lilos/contracts/app";
import type {
  ConversationAccess,
  ModelOption,
  ModelProvider,
  ModelsListResult,
} from "@lilos/contracts/engine";
import type { ModelVisibility } from "@lilos/ui";
import type { EmpBadge } from "@lilos/ui/types";
import { atom, computed, type ReadableAtom } from "nanostores";
import { defaultAccess, defaultEditor } from "../settings/state";
import { badgeStore } from "./badges";
import type { LilosConfig } from "./config";
import { initConnect } from "./connect";
import { hostUser, initHost } from "./host";
import { osFullName, osHome, profile } from "./me";
import { type SessionSignal, SessionWatch } from "./session-watch";

export const booted = atom(false);
export const bootError = atom<string | null>(null);

/** Sidebar drawer open state (mobile `lg:hidden` nav). */
export const navOpen = atom(false);

export let relay: RelayClient;
export let engine: EngineClient;

/**
 * Create the two transport clients and connect them. The relay is required —
 * it owns the visible chat; the engine feed is best-effort: when the harness
 * is down the app still opens, and threads show their messages plus a "why
 * the transcript is missing" line instead of dying at boot (#28 AC-2).
 */
export async function bootRuntime(cfg: LilosConfig): Promise<void> {
  relay = new RelayClient({ url: cfg.relayWs, token: cfg.relayToken });
  engine = new EngineClient({ url: cfg.engineWs, token: cfg.relayToken });
  // #118: the signed-in human's profile is relay-owned — mirror it into the
  // identity atoms; the OS full name prefills the fields the relay left empty.
  relay.profile.listen((s) => profile.set(s));
  // #113: the harness serves the host API on the feed port; folder picking
  // and the thread header's branch badge ride it.
  initHost(cfg);
  void hostUser()
    .then((u) => {
      osFullName.set(u.fullName);
      osHome.set(u.home);
    })
    .catch(() => {});
  let welcome: WelcomeResult;
  try {
    welcome = await relay.connect();
  } catch (e) {
    bootError.set((e as Error).message);
    throw e;
  }
  keepEngineAlive();
  booted.set(true);
  // #85: poll `system.status` so the status row/dialog read the real legs
  // (engine down reasons included), not just socket liveness.
  relay.startStatusPolling(cfg.statusPollMs);
  /* The picker's catalog (issue #71, AC-7): `describe` lands asynchronously
     after connect, so it listens for the `models` capability rather than
     sampling once. #423 AC-3 — the fetch used to run once and drop failures
     on the floor, leaving the picker empty until a reload; now the relay's
     hello-time cache (`welcome.engineHost`) seeds it, the loader retries
     through the host's boot gap, and `host.changed` / a reconnect re-ask
     while the catalog stays empty (#483's fix, same seam). */
  catalogSeed = welcome.engineHost;
  /* A hello sent before the host's first models-carrying report keeps an
     empty seed — every status poll carries the same fields, so keep it
     fresh and re-ask while the catalog is still empty (#423 AC-3). */
  relay.status.listen((s) => {
    catalogSeed = mergeCatalogSeed(catalogSeed, s?.result?.engine);
    if (catalogCapable() && !engineModels.get().length)
      void loadCatalog({ retries: CATALOG_RETRIES });
  });
  const un = engine.description.listen((d) => {
    if (!d?.capabilities.some((c) => c.id === "models")) return;
    un();
    void loadCatalog({ retries: CATALOG_RETRIES });
  });
  /* The host registering again is a fresh catalog source — `models.list`
     answers even though it failed while the host was gone. The event fires
     at harness.register, before the engine finishes booting, so the refresh
     re-polls a few times rather than losing to the boot race (#483). */
  relay.onEvent((method, params) => {
    if (method !== "host.changed") return;
    if (
      (params as { connected?: boolean }).connected === true &&
      catalogCapable()
    )
      void loadCatalog({ refresh: true, retries: CATALOG_RETRIES });
  });
  /* A reconnect after the once-only era: only an empty catalog re-asks. */
  relay.state.listen((s) => {
    if (s === "ready" && catalogCapable() && !engineModels.get().length)
      void loadCatalog({ retries: CATALOG_RETRIES });
  });
  // The LilOS-owned Edit-models list (#92 AC-7) lives in the relay's settings
  // store: seed it once, then follow `settings.changed` so a second window
  // sees the same hide list. The Settings default editor (#132) sits in the
  // same KV, seeded + followed the same way.
  void relay
    .request<{ value: unknown }>("settings.get", { key: "modelVisibility" })
    .then((r) => {
      if (r.value) modelVisibility.set(r.value as ModelVisibility);
    })
    .catch(() => {});
  void relay
    .request<{ value: unknown }>("settings.get", { key: "defaultEditor" })
    .then((r) => {
      if (typeof r.value === "string") defaultEditor.set(r.value);
    })
    .catch(() => {});
  /* #106 AC-3: the access level new conversations open on — LilOS KV,
     seeded + followed like defaultEditor. */
  void relay
    .request<{ value: unknown }>("settings.get", { key: "defaultAccess" })
    .then((r) => {
      if (r.value === "ask" || r.value === "full") defaultAccess.set(r.value);
    })
    .catch(() => {});
  relay.onEvent((method, params) => {
    if (method !== "settings.changed") return;
    const { key, value } = params as { key?: string; value?: unknown };
    if (key === "modelVisibility") {
      modelVisibility.set(
        (value as ModelVisibility) ?? { providers: [], models: [] },
      );
    }
    if (key === "defaultEditor") {
      defaultEditor.set(typeof value === "string" ? value : null);
    }
    if (key === "defaultAccess") {
      defaultAccess.set(
        (value as ConversationAccess | undefined) === "full" ? "full" : "ask",
      );
    }
  });
  // #339: the Connect approval flag + its settings.changed follow-up.
  initConnect();
}

/**
 * EngineClient retries drops *after* a first success but not a failed first
 * connect — keep a retry loop here until it latches, then it owns reconnects.
 */
function keepEngineAlive(): void {
  const attempt = () => {
    if (engine.state.get() === "closed") return; // deliberate teardown
    engine
      .connect()
      .catch(() => {})
      .finally(() => {
        const s = engine.state.get();
        if (s !== "ready" && s !== "reconnecting") setTimeout(attempt, 2_000);
      });
  };
  attempt();
}

/** The engine's selectable-model catalog (`models.list`); empty without the capability. */
export const engineModels = atom<ModelOption[]>([]);

/** `models.list`'s `default` — the engine-owned default a new session starts
    on (#92 AC-5) and the hire-template fallback for a blank model (#115);
    never a LilOS-side default (D-#85). */
export const engineDefaultModel = atom<string | undefined>(undefined);

/** Provider the engine's default model belongs to — ids are unique only
    per provider on multi-provider engines (#92). */
export const engineDefaultProvider = atom<string | undefined>(undefined);

/** Provider rows `models.list` reported — names/logos for picker groups. */
export const engineProviders = atom<ModelProvider[]>([]);

/** The ONE hide list for every employee (#92 AC-7), relay-persisted. */
export const modelVisibility = atom<ModelVisibility>({
  providers: [],
  models: [],
});

/* `host.changed` lands at harness.register while the engine is still
   starting, so a catalog refresh re-asks a bounded number of times before
   giving the attempt up (#483's race). */
const CATALOG_RETRIES = 3;
const CATALOG_RETRY_MS = 800;

/** The relay's hello-time `welcome.engineHost` — its cached `models.list`
    answer seeds the catalog while the live call can't answer (#423 AC-3). */
let catalogSeed: EngineHostStatus | undefined;

/**
 * One live `models.list` answer -> the catalog atoms. Only non-empty rows
 * overwrite — an answered-empty (engine mid-restart) never blanks a picker
 * that already had models.
 */
export function applyModelCatalog(r: ModelsListResult): void {
  if (!r.models?.length) return;
  engineModels.set(r.models);
  engineProviders.set(r.providers ?? []);
  engineDefaultModel.set(r.default);
  engineDefaultProvider.set(r.defaultProvider);
}

/**
 * The engine model catalog (#423 AC-3, mirroring #483's phone fix): seed
 * from the relay-cached `welcome.engineHost` list while nothing is known,
 * then the live `models.list`. A live non-empty answer always wins; a
 * failed or empty one keeps whatever the seed left. Retries bridge the
 * host's boot gap after `host.changed`. Resolves true once rows are on
 * `engineModels` — false only when no source had any.
 */
export async function loadModelCatalog(
  listModels: (params?: { refresh?: boolean }) => Promise<ModelsListResult>,
  host: EngineHostStatus | undefined,
  opts?: { refresh?: boolean; retries?: number; retryMs?: number },
): Promise<boolean> {
  const attempts = 1 + (opts?.retries ?? 0);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0)
      await new Promise((r) =>
        setTimeout(r, opts?.retryMs ?? CATALOG_RETRY_MS),
      );
    /* Optimistic fallback only when nothing is known — a live catalog that
       already landed never downgrades to hello-time rows (#483). */
    if (!engineModels.get().length && host?.models?.length) {
      applyModelCatalog({
        models: host.models,
        providers: host.providers,
        default: host.defaultModel,
        defaultProvider: host.defaultProvider,
      });
    }
    try {
      /* A live answer — even an empty one — ends the poll. A rejection
         re-asks through the budget: rows already on screen may be the
         seed's while the host is still booting (#483's race). */
      applyModelCatalog(await listModels({ refresh: opts?.refresh }));
      return engineModels.get().length > 0;
    } catch {
      /* keep polling */
    }
  }
  return engineModels.get().length > 0;
}

/**
 * Fold a `system.status` engine block into the catalog seed (#423 AC-3):
 * an early hello predates the host's first models-carrying report, so each
 * poll refreshes the fallback — a block without a field never blanks what
 * the seed already holds.
 */
export function mergeCatalogSeed(
  seed: EngineHostStatus | undefined,
  engine: SystemStatusResult["engine"],
): EngineHostStatus | undefined {
  if (!engine) return seed;
  return {
    connected: true,
    state: seed?.state,
    detail: seed?.detail,
    capabilities: engine.capabilities ?? seed?.capabilities,
    models: engine.models ?? seed?.models,
    providers: seed?.providers,
    defaultModel: engine.defaultModel ?? seed?.defaultModel,
    defaultProvider: engine.defaultProvider ?? seed?.defaultProvider,
  };
}

/** Models capability from either source: the engine feed's `describe`, or
    the relay's hello-time `engineHost` report when describe hasn't landed. */
function catalogCapable(): boolean {
  return (
    engine.description.get()?.capabilities.some((c) => c.id === "models") ===
      true || catalogSeed?.capabilities?.some((c) => c.id === "models") === true
  );
}

/** The boot-bound loader: the live call through `relay`, the seed captured
    at hello. `refresh: true` is the host-return path — the engine re-probes
    instead of answering its cache. Triggers overlap by design (describe,
    host.changed, reconnect, every status poll while empty), so one run at
    a time: a caller that arrives mid-flight rides the run already asking. */
let catalogInFlight = false;
async function loadCatalog(opts?: {
  refresh?: boolean;
  retries?: number;
}): Promise<boolean> {
  if (catalogInFlight) return engineModels.get().length > 0;
  catalogInFlight = true;
  try {
    return await loadModelCatalog(
      (params) => relay.listModels(params),
      catalogSeed,
      opts,
    );
  } finally {
    catalogInFlight = false;
  }
}

const modelCache = new Map<string, ReadableAtom<SessionModel>>();

/**
 * Reduced turn model for one engine session — a memoized computed atom over
 * the session's event feed. This is the only place engine events get
 * re-shaped for the UI.
 *
 * #430: the reducer is incremental — a live feed appends, so only the new
 * tail replays and untouched `TurnModel`s keep their identity across
 * deltas (that's what lets the fold cache + memoized rows skip unchanged
 * turns). A resync swaps the snapshot/events and the reducer resets to a
 * full replay — same answer as before.
 */
function sessionModel(sessionId: string): ReadableAtom<SessionModel> {
  let m = modelCache.get(sessionId);
  if (!m) {
    const feed: ReadableAtom<SessionFeedState> = engine.sessionFeed(sessionId);
    const reducer = new SessionReducer(sessionId);
    m = computed(feed, (f) => reducer.apply(f.events, f.snapshot));
    modelCache.set(sessionId, m);
  }
  return m;
}

/**
 * sessionId -> reduced model for every session the relay knows about
 * (conversation.engineRef). A background subscription keeps each watched
 * feed reduced so list rows and badges can read live phases without hooks.
 */
export const sessionModels = atom<Record<string, SessionModel>>({});

/* #572: broadcast-folded truth for sessions WITHOUT a feed — running /
   open asks / life — so badges, the life ring, and notifications answer
   for background sessions without replaying their logs. */
export const sessionSignals = atom<Record<string, SessionSignal>>({});

/* #572: sid -> a feed is attached — the "pending" gate's watched signal
   (an unwatched session mustn't hold relay rows hostage). */
export const sessionWatched = atom<Record<string, boolean>>({});

/** The conversation open in the thread panel — SessionWatch's scope head. */
export const openConversation = atom<string | undefined>(undefined);

/* #427: the sidebar badge map as a computed store — `sessionModels`
   rebuilds on every engine event, but the badge counts almost never move.
   `badgeStore` keeps the same record while counts are equal, so AppShell
   re-renders on real badge changes only. `relay` binds at boot, so the
   computed is built on first read (AppShell mounts post-boot). */
let empBadges: ReadableAtom<Record<string, EmpBadge>> | undefined;
export function employeeBadgeMap(): ReadableAtom<Record<string, EmpBadge>> {
  empBadges ??= badgeStore(
    relay.channels,
    relay.conversations,
    sessionModels,
    sessionSignals,
  );
  return empBadges;
}

/**
 * sessionId -> "has the feed stamped its attach watermark" (#467): latched
 * true once the first `events.since` replay lands (`synced`), stays true
 * across later reconnects (`coverageSeq > 0` means the replayed log is still
 * in the feed — mergeTurns can keep anchoring the stale-but-bound model),
 * and also latches on a terminal replay error so the #28 degraded view keeps
 * showing raw relay rows instead of holding them forever.
 */
export const sessionFeedAttached = atom<Record<string, boolean>>({});

let sessionWatchStarted = false;

/**
 * #572: scope the feeds to the threads that matter — the open conversation
 * plus sessions that are running or asking — instead of replaying every
 * session's full history at boot. Everything else rides relay rows and the
 * broadcast-folded `sessionSignals`; leaving the set releases the feed.
 */
export function watchSessionFeeds(): void {
  if (sessionWatchStarted) return;
  sessionWatchStarted = true;
  new SessionWatch({
    conversations: relay.conversations,
    asks: relay.asks,
    openConversationId: openConversation,
    sessionFeed: (sid) => engine.sessionFeed(sid),
    sessionModel: (sid) => sessionModel(sid),
    releaseSession: (sid) => {
      engine.releaseSession(sid);
      modelCache.delete(sid);
    },
    onEvent: (fn) => engine.onEvent(fn),
    signals: sessionSignals,
    watched: sessionWatched,
    models: sessionModels,
    attached: sessionFeedAttached,
  }).start();
}

/* ------------------------------ workbench opens --------------------------- */

/** A `workbench.opened` relay event as the Workbench's spot request (#340):
    `at` re-fires a repeated open of the same target. */
export interface WorkbenchSpot {
  at: number;
  target: WorkbenchOpenTarget;
}

/** Latest `workbench_open` target per conversation. */
export const workbenchRequests = atom<Record<string, WorkbenchSpot>>({});

/** Call once after boot: the session's `workbench_open` lands as a channel
    event; the newest request per conversation stays on the map for the DM
    page to navigate to and the Workbench to apply. */
export function watchWorkbenchOpens(): void {
  relay.onEvent((method, params) => {
    if (method !== "workbench.opened") return;
    const p = params as {
      conversationId?: string;
      target?: WorkbenchOpenTarget;
    };
    if (!p.conversationId || !p.target) return;
    workbenchRequests.set({
      ...workbenchRequests.get(),
      [p.conversationId]: { at: Date.now(), target: p.target },
    });
  });
}

/* --------------------------------- asks --------------------------------- */

/** Engine asks (approvals + questions) as surfaced on the relay. */
export const asks = atom<Ask[]>([]);

/** Call once after boot: seeds asks from the relay, then tracks ask events. */
export function watchAsks(): void {
  relay
    .request<{ asks: Ask[] }>("asks.list", {})
    .then((res) => asks.set(res.asks))
    .catch(() => {});
  relay.onEvent((method, params) => {
    if (method !== "ask.opened" && method !== "ask.resolved") return;
    const ask = (params as { ask: Ask }).ask;
    const list = asks.get();
    asks.set(
      list.some((a) => a.id === ask.id)
        ? list.map((a) => (a.id === ask.id ? ask : a))
        : [...list, ask],
    );
  });
}
