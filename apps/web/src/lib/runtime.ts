import {
  EngineClient,
  RelayClient,
  reduceSessionEvents,
  type SessionFeedState,
  type SessionModel,
} from "@lilos/client-runtime";
import type { Ask } from "@lilos/contracts/app";
import type { ModelOption, ModelProvider } from "@lilos/contracts/engine";
import type { ModelVisibility } from "@lilos/ui";
import { atom, computed, type ReadableAtom } from "nanostores";
import type { LilosConfig } from "./config";

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
      })
      .catch(() => {});
  });
  // The LilOS-owned Edit-models list (#92 AC-7) lives in the relay's settings
  // store: seed it once, then follow `settings.changed` so a second window
  // sees the same hide list.
  void relay
    .request<{ value: unknown }>("settings.get", { key: "modelVisibility" })
    .then((r) => {
      if (r.value) modelVisibility.set(r.value as ModelVisibility);
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
  });
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
 */
export function sessionModel(sessionId: string): ReadableAtom<SessionModel> {
  let m = modelCache.get(sessionId);
  if (!m) {
    const feed: ReadableAtom<SessionFeedState> = engine.sessionFeed(sessionId);
    m = computed(feed, (f) =>
      reduceSessionEvents(sessionId, f.events, f.snapshot),
    );
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

const feedSubs = new Map<string, () => void>();

/** Call once after boot: keeps `sessionModels` in sync with conversations. */
export function watchSessionFeeds(): void {
  relay.conversations.subscribe((convs) => {
    for (const c of convs) {
      const sid = c.engineRef;
      if (!sid || feedSubs.has(sid)) continue;
      feedSubs.set(
        sid,
        sessionModel(sid).subscribe((m) => {
          if (sessionModels.get()[sid] !== m)
            sessionModels.set({ ...sessionModels.get(), [sid]: m });
        }),
      );
    }
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
