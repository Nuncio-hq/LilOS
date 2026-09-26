import {
  EngineClient,
  RelayClient,
  reduceSessionEvents,
  type SessionFeedState,
  type SessionModel,
} from "@lilos/client-runtime";
import type { Ask } from "@lilos/contracts/app";
import { atom, computed, type ReadableAtom } from "nanostores";
import type { LilosConfig } from "./config";

export const booted = atom(false);
export const bootError = atom<string | null>(null);

/** Sidebar drawer open state (mobile `lg:hidden` nav). */
export const navOpen = atom(false);

export let relay: RelayClient;
export let engine: EngineClient;

/** Create the two transport clients and connect them. Called once by main. */
export async function bootRuntime(cfg: LilosConfig): Promise<void> {
  relay = new RelayClient({ url: cfg.relayWs, token: cfg.relayToken });
  engine = new EngineClient({ url: cfg.engineWs });
  try {
    await Promise.all([relay.connect(), engine.connect()]);
  } catch (e) {
    bootError.set((e as Error).message);
    throw e;
  }
  booted.set(true);
}

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
