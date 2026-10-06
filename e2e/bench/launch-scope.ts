/**
 * Issue #572 AC-1 — launch replay-scope benchmark.
 *
 * Boots the dev stack (relay + harness + vite — vite is unused, the bench
 * speaks relay/feed WS), seeds N conversations with real engine turns via
 * the same calls the composer makes, then drives the app's own feed
 * machinery over a metering socket:
 *
 *   legacy  — the pre-#572 shape: one sessionFeed per engine-bound
 *             conversation → every session's full log replays at boot.
 *   scoped  — the real SessionWatch (open thread + running + asking only)
 *             → idle sessions cost nothing on the wire and nothing retained.
 *
 * Per profile the report carries feed-socket inbound bytes (the AC's "boot
 * traffic"), `events.since` request count, and the retained event bytes —
 * the heap driver the issue's "flat relative to session count" measures
 * (feeds and their folded models are where engine history lives in-page).
 *
 *   bun e2e/bench/launch-scope.ts                    # 31 sessions × 3 turns
 *   bun e2e/bench/launch-scope.ts --sessions 12 --turns 2
 *
 * AC-1 gate: scoped.inboundBytes < 300_000 at 31 sessions.
 */

/* e2e/ sits outside the workspace manifests, so `nanostores` can't resolve
   here — the watch surface only needs get/set/subscribe, which this shim
   provides (nanostores `subscribe` fires the current value immediately —
   same contract). */
import type { ReadableAtom, WritableAtom } from "nanostores";
import { SessionWatch } from "../../apps/web/src/lib/session-watch";
import {
  EngineClient,
  RelayClient,
  SessionReducer,
} from "../../packages/client-runtime/src/index";
import type { RelaySocket } from "../../packages/client-runtime/src/socket";
import type { Ask, Conversation } from "../../packages/contracts/src/app/index";
import type { EngineEvent } from "../../packages/contracts/src/engine/index";
import { bootStack, pickPorts } from "../helpers/stack";

type Sub<T> = (v: T) => void;
const atom = <T>(v: T): WritableAtom<T> => {
  const subs = new Set<Sub<T>>();
  return {
    get: () => v,
    set: (n: T) => {
      v = n;
      for (const f of subs) f(n);
    },
    subscribe: (f: Sub<T>) => {
      subs.add(f);
      f(v);
      return () => subs.delete(f);
    },
  } as WritableAtom<T>;
};
/* computed(feed, reduce): re-reduce on every feed change, subscribers see
   each new model — the app's SessionReducer.apply is incremental either way. */
const computed = <S, T>(
  src: { get(): S; subscribe(f: Sub<S>): () => void },
  reduce: (v: S) => T,
): ReadableAtom<T> => {
  const out = atom(reduce(src.get()));
  src.subscribe((v) => out.set(reduce(v)));
  return out;
};

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const SESSIONS = Math.max(1, Number(arg("sessions", "31")) || 31);
/* ~3 turns per session ≈ the audit's ~90 kB retained log per session. */
const TURNS = Math.max(1, Number(arg("turns", "3")) || 3);
/* A markdown turn — a fat reply means a fat per-session log, the shape the
   2.8 MB/31-session audit saw. */
const PROMPT = "md: blocks";
const USER_ID = "user";
const TICK = arg("tick", "2");
const SETTLE_MS = Number(arg("settle", "4000"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------- metering socket ------------------------- */

interface Meter {
  inboundBytes: number;
  sinceCalls: number;
  liveEvents: number;
}

/** Wraps a real ws: inbound byte + frame-kind counting, outbound
    events.since counting. The client's own listeners attach on top. */
function meteredFactory(acc: Meter) {
  return (url: string): RelaySocket => {
    const ws = new WebSocket(url);
    const send = ws.send.bind(ws);
    ws.send = (data: string) => {
      try {
        const f = JSON.parse(data) as { method?: string };
        if (f.method === "events.since") acc.sinceCalls += 1;
      } catch {}
      return send(data);
    };
    ws.addEventListener("message", (e) => {
      const s = typeof e.data === "string" ? e.data : "";
      acc.inboundBytes += s.length;
      try {
        const f = JSON.parse(s) as { method?: string };
        if (f.method === "event") acc.liveEvents += 1;
      } catch {}
    });
    return ws as unknown as RelaySocket;
  };
}

const poll = async (
  fn: () => boolean,
  ms = 60_000,
  what = "condition",
): Promise<void> => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error(`timed out: ${what}`);
    await sleep(100);
  }
};

/* ------------------------- the two profiles ------------------------- */

const feedBytesRetained = (engine: EngineClient, convs: Conversation[]) =>
  convs.reduce((n, c) => {
    const f = c.engineRef ? engine.feedState(c.engineRef) : undefined;
    return n + (f ? JSON.stringify(f.events).length : 0);
  }, 0);

async function profile(
  stack: { feedWs: string; relayToken: string },
  convs: Conversation[],
  asks: Ask[],
  mode: "legacy" | "scoped",
  openConvId?: string,
): Promise<{
  acc: Meter;
  feedsAttached: number;
  retainedEvents: number;
  retainedBytes: number;
}> {
  const acc: Meter = { inboundBytes: 0, sinceCalls: 0, liveEvents: 0 };
  const engine = new EngineClient({
    url: stack.feedWs,
    token: stack.relayToken,
    socketFactory: meteredFactory(acc),
  });
  await engine.connect();
  try {
    const bound = convs.flatMap((c) =>
      c.engineRef ? [{ conv: c, sid: c.engineRef }] : [],
    );
    if (mode === "legacy") {
      /* Pre-#572 watchSessionFeeds: a feed — and its replay — per conv. */
      const feeds = bound.map((b) => engine.sessionFeed(b.sid));
      await poll(
        () => feeds.every((f) => f.get().synced || f.get().error),
        120_000,
        "legacy replays",
      );
    } else {
      /* The real watch over the app's own atoms — one open thread max. */
      const modelCache = new Map<string, ReturnType<typeof computed>>();
      const sessionModel = (sid: string) => {
        let m = modelCache.get(sid);
        if (!m) {
          const feed = engine.sessionFeed(sid);
          const reducer = new SessionReducer(sid);
          m = computed(feed, (f) => reducer.apply(f.events, f.snapshot));
          modelCache.set(sid, m);
        }
        return m;
      };
      const watch = new SessionWatch({
        conversations: atom(convs),
        asks: atom(asks),
        openConversationId: atom(openConvId),
        sessionFeed: (sid) => engine.sessionFeed(sid),
        sessionModel,
        releaseSession: (sid) => {
          engine.releaseSession(sid);
          modelCache.delete(sid);
        },
        onEvent: (fn) => engine.onEvent(fn),
        signals: atom({}),
        watched: atom({}),
        models: atom({}),
        attached: atom({}),
      });
      watch.start();
      await sleep(SETTLE_MS);
    }
    const feeds = bound
      .map((b) => engine.feedState(b.sid))
      .filter((f) => f !== undefined);
    return {
      acc,
      feedsAttached: feeds.length,
      retainedEvents: feeds.reduce((n, f) => n + f.events.length, 0),
      retainedBytes: feedBytesRetained(engine, convs),
    };
  } finally {
    engine.close();
  }
}

/* ------------------------- seeding ------------------------- */

async function main() {
  const ports = await pickPorts();
  console.log(
    `[launch-scope] booting stack relay=${ports.relay} feed=${ports.feed}`,
  );
  const stack = await bootStack("launchscope", ports, {
    LILOS_USER_NAME: "Oscar",
    ENGINE_FAKE_TICK: TICK,
  });
  try {
    const relay = new RelayClient({
      url: stack.relayWs,
      token: stack.relayToken,
    });
    /* engine.event frames reach channel subscribers only. */
    const completed = new Map<string, () => void>();
    relay.onEvent((method, params) => {
      if (method !== "engine.event") return;
      const p = params as {
        conversationId?: string;
        event?: EngineEvent;
      };
      if (p.event?.type !== "turn.completed") return;
      completed.get(p.conversationId ?? "")?.();
    });
    await relay.connect();
    await poll(
      () => relay.directoryReady.get(),
      30_000,
      "relay directory load",
    );
    const dm = relay.channels.get().find((c) => c.kind === "dm");
    if (!dm) throw new Error("no dm channel in the seeded stack");
    await relay.request("channel.subscribe", { channelId: dm.id });

    const waitTurn = async (conversationId: string) => {
      const done = new Promise<void>((resolve) =>
        completed.set(conversationId, resolve),
      );
      await Promise.race([
        done,
        sleep(60_000).then(() => {
          throw new Error(`turn never completed for ${conversationId}`);
        }),
      ]);
      completed.delete(conversationId);
    };

    /* Sessions fan out in parallel — engine-fake runs them independently. */
    const started = Date.now();
    await Promise.all(
      Array.from({ length: SESSIONS }, async (_, i) => {
        const res = await relay.request<{ conversation: { id: string } }>(
          "conversations.open",
          { channelId: dm.id, authorId: USER_ID, text: PROMPT },
        );
        const convId = res.conversation.id;
        await waitTurn(convId);
        for (let t = 1; t < TURNS; t++) {
          await relay.request("messages.post", {
            channelId: dm.id,
            conversationId: convId,
            authorId: USER_ID,
            authorKind: "user",
            text: PROMPT,
          });
          await waitTurn(convId);
        }
        if ((i + 1) % 10 === 0)
          console.log(`[launch-scope] seeded ${i + 1}/${SESSIONS}`);
      }),
    );
    const seedMs = Date.now() - started;

    const { conversations } = await relay.request<{
      conversations: Conversation[];
    }>("conversations.list", { channelId: dm.id });
    const convs = conversations.filter((c) => c.engineRef);
    const { asks } = await relay.request<{ asks: Ask[] }>("asks.list", {});

    const legacy = await profile(stack, convs, asks, "legacy");
    const scoped = await profile(stack, convs, asks, "scoped");
    const scopedOpen = await profile(
      stack,
      convs,
      asks,
      "scoped",
      convs[0]?.id,
    );

    const summary = {
      sessions: convs.length,
      seedMs,
      budgetBytes: 300_000,
      legacy: {
        inboundBytes: legacy.acc.inboundBytes,
        sinceCalls: legacy.acc.sinceCalls,
        feedsAttached: legacy.feedsAttached,
        retainedEvents: legacy.retainedEvents,
        retainedBytes: legacy.retainedBytes,
      },
      scoped: {
        inboundBytes: scoped.acc.inboundBytes,
        sinceCalls: scoped.acc.sinceCalls,
        feedsAttached: scoped.feedsAttached,
        retainedEvents: scoped.retainedEvents,
        retainedBytes: scoped.retainedBytes,
      },
      /* The open thread still replays — scope + one thread. */
      scopedOneOpen: {
        inboundBytes: scopedOpen.acc.inboundBytes,
        sinceCalls: scopedOpen.acc.sinceCalls,
        feedsAttached: scopedOpen.feedsAttached,
      },
      ac1:
        scoped.acc.inboundBytes < 300_000 &&
        scopedOpen.acc.inboundBytes < 300_000
          ? "PASS"
          : "FAIL",
    };
    console.log(`\n[launch-scope] ${JSON.stringify(summary, null, 2)}`);
    relay.close();
  } finally {
    await stack.stop();
  }
}

await main();
