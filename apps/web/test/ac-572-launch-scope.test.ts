/**
 * Issue #572 — replay only the threads that matter at launch.
 *
 *   AC-1: boot must not replay every session — feeds attach only for the
 *         open thread and sessions that are running or need the user; a
 *         session that closes or archives releases its feed so the log GCs.
 *   AC-2: badges keep updating for unwatched background sessions — the
 *         cheap per-session signal folded off the live broadcast (seeded by
 *         the relay's conversation rows and asks) replaces the full model.
 */
import type { SessionFeedState, SessionModel } from "@lilos/client-runtime";
import type { Ask, Conversation } from "@lilos/contracts/app";
import type { EngineEvent } from "@lilos/contracts/engine";
import { atom, type WritableAtom } from "nanostores";
import { describe, expect, it } from "vitest";
import {
  foldSessionSignal,
  type SessionSignal,
  SessionWatch,
} from "../src/lib/session-watch";

const conv = (
  id: string,
  engineRef: string | null,
  over: Partial<Conversation> = {},
): Conversation => ({
  id,
  channelId: "ch-dm",
  rootMessageId: `m-${id}`,
  engineRef,
  state: "idle",
  title: "",
  titleSource: "user",
  access: "ask",
  archived: false,
  deliveredSeq: 0,
  createdAt: 0,
  ...over,
});

const ask = (
  id: string,
  conversationId: string,
  requestId: string,
  state: "open" | "resolved" = "open",
): Ask => ({
  id,
  channelId: "ch-dm",
  conversationId,
  turnId: "t1",
  requestId,
  request: { kind: "approval", command: `run ${id}`, options: ["once"] },
  state,
  createdAt: 0,
});

const ev = (
  sessionId: string,
  seq: number,
  type: EngineEvent["type"],
  payload: Record<string, unknown> = {},
): EngineEvent => ({ seq, sessionId, type, payload }) as EngineEvent;

const model = (over: Partial<SessionModel> = {}): SessionModel => ({
  sessionId: "s",
  state: "idle",
  turns: [],
  jobs: [],
  subagentJobs: [],
  openRequests: [],
  ...over,
});

/** A stubbed EngineClient surface: feeds are atoms the test mutates. */
const stubEngine = () => {
  const feeds = new Map<string, WritableAtom<SessionFeedState>>();
  const models = new Map<string, WritableAtom<SessionModel>>();
  const listeners = new Set<(e: EngineEvent) => void>();
  const released: string[] = [];
  const feed = (sid: string) => {
    let f = feeds.get(sid);
    if (!f) {
      f = atom<SessionFeedState>({
        sessionId: sid,
        synced: false,
        latestSeq: 0,
        coverageSeq: 0,
        events: [],
        openRequests: [],
      });
      feeds.set(sid, f);
    }
    return f;
  };
  return {
    feeds,
    released,
    emit: (e: EngineEvent) => {
      for (const fn of listeners) fn(e);
    },
    setModel: (sid: string, m: SessionModel) => {
      let s = models.get(sid);
      if (!s) {
        s = atom(m);
        models.set(sid, s);
      } else s.set(m);
    },
    deps: {
      sessionFeed: feed,
      sessionModel: (sid: string) => {
        let s = models.get(sid);
        if (!s) {
          s = atom(model({ sessionId: sid }));
          models.set(sid, s);
        }
        return s;
      },
      releaseSession: (sid: string) => {
        released.push(sid);
        feeds.delete(sid);
      },
      onEvent: (fn: (e: EngineEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
  };
};

const setup = (convs: Conversation[], asks: Ask[] = []) => {
  const engine = stubEngine();
  const conversations = atom<Conversation[]>(convs);
  const asksAtom = atom<Ask[]>(asks);
  const open = atom<string | undefined>(undefined);
  const signals = atom<Record<string, SessionSignal>>({});
  const watched = atom<Record<string, boolean>>({});
  const modelsAtom = atom<Record<string, SessionModel>>({});
  const attachedAtom = atom<Record<string, boolean>>({});
  const watch = new SessionWatch({
    ...engine.deps,
    conversations,
    asks: asksAtom,
    openConversationId: open,
    signals,
    watched,
    models: modelsAtom,
    attached: attachedAtom,
  });
  watch.start();
  return { engine, conversations, asksAtom, open, watch, signals };
};

const attached = (engine: ReturnType<typeof stubEngine>) =>
  [...engine.feeds.keys()].sort();

describe("#572 AC-1 feeds attach only for the open, running, or asking", () => {
  it("AC-1 31 idle sessions at boot: zero feeds attach", () => {
    const convs = Array.from({ length: 31 }, (_, i) => conv(`c${i}`, `s${i}`));
    const { engine } = setup(convs);
    expect(attached(engine)).toEqual([]);
  });

  it("AC-1 boot watches a session the row marks running, plus the open thread", () => {
    const convs = [
      ...Array.from({ length: 29 }, (_, i) => conv(`c${i}`, `s${i}`)),
      conv("running", "s-run", { state: "active" }),
      conv("open", "s-open"),
    ];
    const { engine, open } = setup(convs);
    expect(attached(engine)).toEqual(["s-run"]);
    open.set("open");
    expect(attached(engine)).toEqual(["s-open", "s-run"]);
  });

  it("AC-1 an open ask on the row watches the session without a replay flag", () => {
    const convs = [conv("c1", "s1"), conv("c2", "s2")];
    const { engine } = setup(convs, [ask("a1", "c2", "r-1")]);
    expect(attached(engine)).toEqual(["s2"]);
  });

  it("AC-1 archived or closed conversations never attach", () => {
    const convs = [
      conv("arch", "s-arch", { archived: true, state: "active" }),
      conv("dead", "s-dead", { life: "closed", state: "active" }),
      conv("live", "s-live", { state: "active" }),
    ];
    const { engine } = setup(convs);
    expect(attached(engine)).toEqual(["s-live"]);
  });

  it("AC-1 archiving a watched session releases its feed", () => {
    const c = conv("c1", "s1", { state: "active" });
    const { engine, conversations } = setup([c]);
    expect(attached(engine)).toEqual(["s1"]);
    conversations.set([{ ...c, archived: true }]);
    expect(engine.released).toEqual(["s1"]);
    expect(attached(engine)).toEqual([]);
  });

  it("AC-1 a session.state closed broadcast releases the feed even while the row is stale", () => {
    const c = conv("c1", "s1", { state: "active" });
    const { engine } = setup([c]);
    expect(attached(engine)).toEqual(["s1"]);
    engine.emit(ev("s1", 9, "session.state", { state: "closed" }));
    expect(engine.released).toEqual(["s1"]);
  });

  it("AC-1 a turn starting in the background attaches; its completion releases", () => {
    const c = conv("c1", "s1");
    const { engine } = setup([c]);
    engine.emit(ev("s1", 1, "turn.started", { turnId: "t1" }));
    expect(attached(engine)).toEqual(["s1"]);
    engine.emit(ev("s1", 2, "turn.completed", { turnId: "t1" }));
    expect(attached(engine)).toEqual([]);
    expect(engine.released).toEqual(["s1"]);
  });

  it("AC-1 navigating away from a quiet thread releases its feed", () => {
    const convs = [conv("c1", "s1"), conv("c2", "s2")];
    const { engine, open } = setup(convs);
    open.set("c1");
    expect(attached(engine)).toEqual(["s1"]);
    open.set("c2");
    expect(attached(engine)).toEqual(["s2"]);
    expect(engine.released).toEqual(["s1"]);
  });

  it("AC-1 a synced feed whose model settled clears a stale running flag", () => {
    /* The row said "active" at boot but the replayed log shows the turn
       ended (a stale snapshot / a completion the broadcast missed). Once
       the feed is synced the model is the truth — don't pin the feed. */
    const c = conv("c1", "s1", { state: "active" });
    const { engine } = setup([c]);
    expect(attached(engine)).toEqual(["s1"]);
    engine.setModel("s1", model({ sessionId: "s1", live: undefined }));
    engine.feeds.get("s1")?.set({
      sessionId: "s1",
      synced: true,
      latestSeq: 5,
      coverageSeq: 5,
      events: [],
      openRequests: [],
    });
    expect(attached(engine)).toEqual([]);
  });
});

describe("#572 AC-2 signals fold the live broadcast, not a replay", () => {
  it("request.opened marks the session needing attention until resolved", () => {
    const { engine, signals } = setup([conv("c1", "s1")]);
    engine.emit(
      ev("s1", 1, "request.opened", {
        turnId: "t1",
        requestId: "r1",
        request: { kind: "approval", command: "rm -rf x", options: ["once"] },
      }),
    );
    expect(attached(engine)).toEqual(["s1"]);
    expect(signals.get().s1?.openRequests.has("r1")).toBe(true);
    engine.emit(
      ev("s1", 2, "request.resolved", { requestId: "r1", outcome: "once" }),
    );
    expect(signals.get().s1?.openRequests.size ?? 0).toBe(0);
    expect(attached(engine)).toEqual([]);
  });

  it("a fresh directory snapshot re-seeds signals (reconnect truth)", () => {
    const c = conv("c1", "s1", { state: "active" });
    const { engine, conversations } = setup([c]);
    expect(attached(engine)).toEqual(["s1"]);
    /* Reconnect re-pulls the list — the row now says idle. */
    conversations.set([{ ...c, state: "idle" }]);
    expect(attached(engine)).toEqual([]);
  });

  it("foldSessionSignal tracks running and life from broadcast events", () => {
    let s = foldSessionSignal(undefined, ev("s", 1, "turn.started", {}));
    expect(s?.running).toBe(true);
    s = foldSessionSignal(s, ev("s", 2, "turn.completed", {}));
    expect(s?.running).toBe(false);
    s = foldSessionSignal(s, ev("s", 3, "session.state", { state: "closed" }));
    expect(s?.life).toBe("closed");
    s = foldSessionSignal(s, ev("s", 4, "session.started", {}));
    expect(s?.life).toBe("open");
  });
});
