import {
  EngineClient,
  RelayClient,
  type SessionFeedState,
  type SessionModel,
  SessionReducer,
} from "@lilos/client-runtime";
import type { Ask, WorkbenchOpenTarget } from "@lilos/contracts/app";
import type {
  ConversationAccess,
  ModelOption,
  ModelProvider,
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
  engine = new EngineClient({ url: cfg.engineWs });
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
  try {
    await relay.connect();
  } catch (e) {
    bootError.set((e as Error).message);
    throw e;
  }
  keepEngineAlive();
  booted.set(true);
  // #85: poll `system.status` so the status row/dialog read the real legs
  // (engine down reasons included), not just socket liveness.
  relay.startStatusPolling(cfg.statusPollMs);
  // The picker's catalog: models.list via the relay, once, when the engine
  // declares the `models` capability (issue #71, AC-7). `describe` lands
  // asynchronously after connect, so listen for it rather than sampling once.
  const un = engine.description.listen((d) => {
    if (!d?.capabilities.some((c) => c.id === "models")) return;
    un();
    void relay
      .listModels()
      .then((r) => {
        engineModels.set(r.models);
        engineProviders.set(r.providers ?? []);
        engineDefaultModel.set(r.default);
        engineDefaultProvider.set(r.defaultProvider);
      })
      .catch(() => {});
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

/* #427: the sidebar badge map as a computed store — `sessionModels`
   rebuilds on every engine event, but the badge counts almost never move.
   `badgeStore` keeps the same record while counts are equal, so AppShell
   re-renders on real badge changes only. `relay` binds at boot, so the
   computed is built on first read (AppShell mounts post-boot). */
let empBadges: ReadableAtom<Record<string, EmpBadge>> | undefined;
export function employeeBadgeMap(): ReadableAtom<Record<string, EmpBadge>> {
  empBadges ??= badgeStore(relay.channels, relay.conversations, sessionModels);
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

const feedSubs = new Map<string, () => void>();

/** Call once after boot: keeps `sessionModels` in sync with conversations. */
export function watchSessionFeeds(): void {
  relay.conversations.subscribe((convs) => {
    for (const c of convs) {
      const sid = c.engineRef;
      if (!sid || feedSubs.has(sid)) continue;
      const unModel = sessionModel(sid).subscribe((m) => {
        if (sessionModels.get()[sid] !== m)
          sessionModels.set({ ...sessionModels.get(), [sid]: m });
      });
      const unAttach = engine.sessionFeed(sid).subscribe((f) => {
        const attached = f.synced || f.error !== undefined || f.coverageSeq > 0;
        if (sessionFeedAttached.get()[sid] !== attached)
          sessionFeedAttached.set({
            ...sessionFeedAttached.get(),
            [sid]: attached,
          });
      });
      feedSubs.set(sid, () => {
        unModel();
        unAttach();
      });
    }
  });
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
