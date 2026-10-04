import type {
  ChannelMessagesState,
  RelayConnectionState,
  RelaySessionFeedState,
  StatusPollState,
} from "@lilos/client-runtime";
import { type CachedDirectory, RelayError } from "@lilos/client-runtime";
import type {
  AppChannel,
  AppMessage,
  Ask,
  Conversation,
  ConversationSummary,
  Employee,
  PairedDevice,
  ProfileSettings,
  WelcomeResult,
} from "@lilos/contracts/app";
import type {
  EngineEvent,
  Job,
  ModelsListResult,
  SessionSnapshot,
} from "@lilos/contracts/engine";
import type { ForgePrListItem } from "@lilos/contracts/host";
import { atom, type WritableAtom } from "nanostores";
import type { TurnCtx } from "./engine";
import { handleRequest } from "./requests";
import {
  DEMO_SEEDS,
  firstTurnScript,
  followUpScript,
  RESUME_ON_OPEN,
  SLEEP_THREAD,
} from "./seeds";
import {
  DEMO_CAPABILITIES,
  DEMO_DEFAULT_MODEL,
  DEMO_DEFAULT_PROVIDER,
  DEMO_MODELS,
  DEMO_PROFILE,
  DEMO_PROVIDERS,
  DEMO_PRS,
  demoChannels,
  demoEmployees,
} from "./team";
import { claimQueued, playTurn, respondToAsk, resumeTurn } from "./turns";
import type { DemoAsk, DemoScript, SeedConversation } from "./types";

/**
 * The demo data source (#168): a fake Mac + scripted engine behind the
 * AppClient surface, so every screen renders without ever opening a socket.
 * Conversation history bakes through the same event path as live turns, so
 * a seeded thread and a fresh one are indistinguishable to the UI.
 */

export interface DemoConv {
  conv: Conversation;
  root: AppMessage;
  messages: AppMessage[];
  events: EngineEvent[];
  latestSeq: number;
  /** The open turn (held on an ask or still mid-script), if any. */
  turn?: DemoTurn;
  /** One waiting ask per open turn — `asks.list` reports it; `askSeq` is
      the request.opened seq the feed's openRequests replay needs. */
  ask?: { ask: Ask; spec: DemoAsk; askSeq: number };
  prs: ForgePrListItem[];
  jobs: Job[];
  /** User messages queued while a turn runs (#315 waiting tray). */
  queued: AppMessage[];
  /** played: the thread's open-triggered live turn ran already. */
  played: boolean;
}

export interface DemoTurn {
  turnId: string;
  ctx: TurnCtx;
  /** Set when the current playScript hit an ask or hold — the turn stays
     open until a script resumes it. */
  held: boolean;
  dead: boolean;
}

const DEMO_SESSION_PFX = "ses_demo_";

export class DemoClient {
  readonly state: WritableAtom<RelayConnectionState> = atom("idle");
  readonly employees: WritableAtom<Employee[]> = atom([]);
  readonly channels: WritableAtom<AppChannel[]> = atom([]);
  readonly conversations: WritableAtom<Conversation[]> = atom([]);
  readonly conversationSummaries: WritableAtom<ConversationSummary[]> = atom(
    [],
  );
  readonly profile: WritableAtom<ProfileSettings> = atom(DEMO_PROFILE);
  readonly asks: WritableAtom<Ask[]> = atom([]);
  readonly devices: WritableAtom<PairedDevice[]> = atom([]);
  readonly directoryReady: WritableAtom<boolean> = atom(false);
  readonly fatal: WritableAtom<RelayError | undefined> = atom(undefined);
  readonly rewinds: WritableAtom<
    Record<string, { fromSeq: number; removedIds: string[] }>
  > = atom({});
  readonly status: WritableAtom<StatusPollState> = atom<StatusPollState>({
    connection: "ready",
  });

  lastSocketError: RelayError | undefined;

  readonly convs = new Map<string, DemoConv>();
  private readonly chanStores = new Map<
    string,
    WritableAtom<ChannelMessagesState>
  >();
  private readonly feeds = new Map<
    string,
    WritableAtom<RelaySessionFeedState>
  >();
  private readonly listeners = new Set<
    (method: string, params: Record<string, unknown>) => void
  >();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** Internal — messages.ts and the seed path number channel rows. */
  readonly channelSeqs = new Map<string, number>();
  /** Internal counters — turns.ts mints turn/ask ids through these. */
  askCounter = 0;
  turnCounter = 0;
  private convCounter = 0;
  /** In-memory settings KV (the demo never writes a real store). */
  private readonly settings = new Map<string, unknown>();

  /** Every seeded conversation's baked log + held turns, then the live
     open-timer scripts — all inside `connect()`, matching the real
     client's "ready then directory lands" ordering. */
  async connect(): Promise<WelcomeResult> {
    const now = Date.now();
    for (const seed of DEMO_SEEDS) await this.seedConv(seed, now);
    this.employees.set(demoEmployees(now));
    this.channels.set(
      demoChannels(now, Object.fromEntries(this.channelSeqs.entries())),
    );
    this.profile.set(DEMO_PROFILE);
    this.devices.set([
      {
        id: "dev-this-iphone",
        name: "This iPhone",
        pairedAt: now - 4 * 60_000,
        lastSeenAt: now,
      },
    ]);
    this.directoryReady.set(true);
    this.state.set("ready");
    /* Held turns resume live once the demo is open (prototype startLife). */
    for (const [convId, resume] of Object.entries(RESUME_ON_OPEN)) {
      const conv = this.convs.get(convId);
      if (!conv) continue;
      this.later(() => {
        void this.resumeTurn(conv, resume.script);
      }, resume.delayMs);
    }
    return {
      protocolVersion: 1,
      relayVersion: "0.1.0-demo",
      instanceId: "demo",
      engineHost: {
        connected: true,
        state: "running",
        detail: "Hermes (demo)",
        capabilities: DEMO_CAPABILITIES,
        models: DEMO_MODELS,
        providers: DEMO_PROVIDERS,
        defaultModel: DEMO_DEFAULT_MODEL,
        defaultProvider: DEMO_DEFAULT_PROVIDER,
      },
    };
  }

  close(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const conv of this.convs.values()) {
      if (conv.turn) conv.turn.dead = true;
    }
    this.state.set("closed");
  }

  async ping(): Promise<void> {
    /* Offline: resolves instantly. */
  }

  async listModels(_params?: { refresh?: boolean }): Promise<ModelsListResult> {
    return this.request<ModelsListResult>("models.list", {});
  }

  onEvent(fn: (method: string, params: Record<string, unknown>) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  fire(method: string, params: Record<string, unknown>): void {
    for (const fn of this.listeners) {
      try {
        fn(method, params);
      } catch {
        /* a listener must never break the demo */
      }
    }
  }

  hydrate(_snapshot: CachedDirectory): void {
    /* The demo keeps no device cache — nothing to hydrate. */
  }

  snapshot(): CachedDirectory {
    return {
      schemaVersion: 1,
      savedAt: Date.now(),
      employees: this.employees.get(),
      channels: this.channels.get(),
      conversations: this.conversations.get(),
      conversationSummaries: this.conversationSummaries.get(),
      profile: this.profile.get(),
      watermarks: {},
    };
  }

  async request<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    if (this.state.get() !== "ready") {
      throw new RelayError(`demo is closed`, "closed");
    }
    return (await handleRequest(this, method, params)) as T;
  }

  channelMessages(channelId: string): WritableAtom<ChannelMessagesState> {
    let store = this.chanStores.get(channelId);
    if (!store) {
      store = atom<ChannelMessagesState>({
        channelId,
        synced: true,
        lastSeq: this.channelSeqs.get(channelId) ?? 0,
        messages: [],
      });
      this.chanStores.set(channelId, store);
    }
    return store;
  }

  sessionFeed(conversationId: string): WritableAtom<RelaySessionFeedState> {
    let store = this.feeds.get(conversationId);
    if (!store) {
      const conv = this.convs.get(conversationId);
      store = atom<RelaySessionFeedState>({
        conversationId,
        sessionId: conv?.conv.engineRef ?? undefined,
        synced: true,
        latestSeq: conv?.latestSeq ?? 0,
        coverageSeq: conv?.latestSeq ?? 0,
        events: conv ? [...conv.events] : [],
        openRequests: conv?.ask
          ? [
              {
                requestId: conv.ask.ask.requestId,
                turnId: conv.ask.ask.turnId,
                request: conv.ask.ask.request,
                seq: conv.ask.askSeq,
              },
            ]
          : [],
        snapshot: conv ? this.snapshotOf(conv) : undefined,
      });
      this.feeds.set(conversationId, store);
      /* The sleep thread's second message sat queued at seed time — the
         engine claims it the first time its feed opens (playOnOpen). */
      if (conversationId === SLEEP_THREAD && conv && !conv.played) {
        conv.played = true;
        this.later(() => this.claimQueued(conv), 600);
      }
    }
    return store;
  }

  async unsubscribeChannel(_channelId: string): Promise<void> {
    /* No subscriptions to release in the demo. */
  }

  /* ---------- turn plumbing (also used by requests.ts handlers) ---------- */

  later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  liveDelay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      this.later(resolve, ms);
    });

  /** One engine event onto the conv's log, its feed atom, and the
     `engine.event` notification every listener (PR refresher) reads. */
  emit(conv: DemoConv, type: string, payload: Record<string, unknown>): void {
    const turn = conv.turn;
    if (turn?.dead) return;
    const event = {
      seq: ++conv.latestSeq,
      sessionId: conv.conv.engineRef ?? DEMO_SESSION_PFX + conv.conv.id,
      type,
      payload,
    } as EngineEvent;
    conv.events.push(event);
    const store = this.feeds.get(conv.conv.id);
    if (store) {
      const f = store.get();
      store.set({
        ...f,
        sessionId: event.sessionId,
        latestSeq: event.seq,
        coverageSeq: event.seq,
        events: [...f.events, event],
        openRequests: conv.ask
          ? [
              {
                requestId: conv.ask.ask.requestId,
                turnId: conv.ask.ask.turnId,
                request: conv.ask.ask.request,
                seq: conv.ask.askSeq,
              },
            ]
          : [],
        snapshot: this.snapshotOf(conv),
      });
    }
    this.fire("engine.event", {
      channelId: conv.conv.channelId,
      conversationId: conv.conv.id,
      sessionId: event.sessionId,
      event,
    });
  }

  snapshotOf(conv: DemoConv): SessionSnapshot {
    const waiting = conv.ask !== undefined;
    return {
      sessionId: conv.conv.engineRef ?? DEMO_SESSION_PFX + conv.conv.id,
      state: waiting ? "waiting" : conv.turn ? "running" : "idle",
      ...(conv.turn
        ? { turn: { turnId: conv.turn.turnId, phase: "tools" } }
        : {}),
      ...(conv.conv.usage ? { usage: conv.conv.usage } : {}),
      ...(conv.conv.model ? { model: conv.conv.model } : {}),
      ...(conv.conv.provider ? { provider: conv.conv.provider } : {}),
      ...(conv.conv.effort ? { effort: conv.conv.effort } : {}),
      title: conv.conv.title,
    };
  }

  private nextMsgSeq(channelId: string): number {
    const seq = (this.channelSeqs.get(channelId) ?? 0) + 1;
    this.channelSeqs.set(channelId, seq);
    return seq;
  }

  postMessage(
    channelId: string,
    body: {
      text: string;
      authorId: string;
      authorKind: AppMessage["authorKind"];
      conversationId?: string | null;
      model?: string;
      provider?: string;
      effort?: string;
      fast?: boolean;
      createdAt?: number;
    },
  ): AppMessage {
    const seq = this.nextMsgSeq(channelId);
    const message: AppMessage = {
      id: `m-${channelId}-${seq}`,
      channelId,
      authorId: body.authorId,
      text: body.text,
      seq,
      createdAt: body.createdAt ?? Date.now(),
      conversationId: body.conversationId ?? null,
      authorKind: body.authorKind,
      rewound: false,
      dropped: false,
      removed: false,
      claimed: false,
      ...(body.model ? { model: body.model } : {}),
      ...(body.provider ? { provider: body.provider } : {}),
      ...(body.effort ? { effort: body.effort } : {}),
      ...(body.fast ? { fast: body.fast } : {}),
    };
    const conv = body.conversationId
      ? this.convs.get(body.conversationId)
      : undefined;
    if (conv) conv.messages.push(message);
    const store = this.chanStores.get(channelId);
    if (store) {
      const s = store.get();
      store.set({ ...s, lastSeq: seq, messages: [...s.messages, message] });
    }
    this.patchSummary(body.conversationId ?? null, message);
    this.fire("message.created", { channelId, message });
    return message;
  }

  private patchSummary(
    conversationId: string | null,
    message: AppMessage,
  ): void {
    if (!conversationId) return;
    const conv = this.convs.get(conversationId);
    const list = this.conversationSummaries.get();
    const idx = list.findIndex((s) => s.conversation.id === conversationId);
    if (idx === -1 || !conv) return;
    const s = list[idx];
    const messages = conv.messages.filter((m) => !m.removed && !m.dropped);
    const next: ConversationSummary = {
      conversation: conv.conv,
      root: s.root,
      firstAnswer:
        s.firstAnswer ??
        (message.authorKind === "employee" ? message : undefined),
      last: message,
      messageCount: messages.length,
    };
    this.conversationSummaries.set(list.map((x, i) => (i === idx ? next : x)));
  }

  /* ---------- seeded history ---------- */

  private async seedConv(seed: SeedConversation, now: number): Promise<void> {
    const createdAt = now - seed.ageMin * 60_000;
    const conv: DemoConv = {
      conv: {
        id: seed.id,
        channelId: seed.channelId,
        rootMessageId: "",
        engineRef: seed.session,
        state: "active",
        title: seed.title,
        titleSource: "auto",
        access: "ask",
        archived: false,
        deliveredSeq: 0,
        createdAt,
        ...(seed.cwd ? { cwd: seed.cwd } : {}),
        ...(seed.workspace ? { workspace: seed.workspace } : {}),
        ...(seed.model ? { model: seed.model } : {}),
        ...(seed.provider ? { provider: seed.provider } : {}),
        ...(seed.effort ? { effort: seed.effort } : {}),
        ...(seed.fast !== undefined ? { fast: seed.fast } : {}),
      },
      root: undefined as unknown as AppMessage,
      messages: [],
      events: [],
      latestSeq: 0,
      prs: [...(DEMO_PRS[seed.id] ?? [])],
      jobs: [],
      queued: [],
      played: false,
    };
    this.convs.set(seed.id, conv);
    /* Per-conversation bake clock: later legs land later. */
    let clock = createdAt;
    for (const leg of seed.legs) {
      clock += 45_000;
      const user = this.postMessage(seed.channelId, {
        text: leg.text,
        authorId: "user",
        authorKind: "user",
        conversationId: seed.id,
        createdAt: clock,
      });
      if (!conv.root) {
        conv.root = user;
        conv.conv = { ...conv.conv, rootMessageId: user.id };
      }
      if (!leg.script) {
        /* A queued user message the engine hasn't claimed (#315 tray). */
        conv.queued.push(user);
        continue;
      }
      conv.conv = { ...conv.conv, deliveredSeq: user.seq };
      clock += 5_000;
      await this.bakeTurn(conv, leg.script, clock);
      clock += 120_000;
    }
    if (!conv.turn) conv.conv = { ...conv.conv, state: "idle" };
    const visible = conv.messages.filter((m) => !m.removed);
    const summary: ConversationSummary = {
      conversation: conv.conv,
      root: conv.root,
      firstAnswer: visible.find((m) => m.authorKind === "employee"),
      last: visible[visible.length - 1] ?? conv.root,
      messageCount: visible.length,
    };
    this.conversations.set([...this.conversations.get(), conv.conv]);
    this.conversationSummaries.set([
      ...this.conversationSummaries.get(),
      summary,
    ]);
  }

  /** A fully synchronous turn — bakes history, no timers. */
  private async bakeTurn(
    conv: DemoConv,
    script: DemoScript,
    at: number,
  ): Promise<void> {
    await this.playTurn(conv, script, {
      live: false,
      at,
      initiatedBy: "user",
    });
  }

  /** The live path — timers pace deltas; ask/hold leave the turn open. */
  /* The turn driver lives in turns.ts (file-size convention); these are
     thin delegates — requests.ts and the feed path call them unchanged. */
  playTurn(
    conv: DemoConv,
    script: DemoScript,
    opts: { live: boolean; initiatedBy?: "user" | "system"; at?: number },
  ): Promise<void> {
    return playTurn(this, conv, script, opts);
  }

  resumeTurn(conv: DemoConv, script: DemoScript): Promise<void> {
    return resumeTurn(this, conv, script);
  }

  respondToAsk(askId: string, outcome: string, answer?: string) {
    return respondToAsk(this, askId, outcome, answer);
  }

  claimQueued(conv: DemoConv): void {
    claimQueued(this, conv);
  }

  /* ---------- live writes (requests.ts calls these) ---------- */

  /** `conversations.open`: the conv + its root user message, then the
      engine claims it (a beat later, so the open screen lands first). */
  openConversation(params: {
    channelId: string;
    title: string;
    text: string;
    authorId: string;
    cwd?: string;
    workspace?: Conversation["workspace"];
    model?: string;
    provider?: string;
    effort?: string;
    fast?: boolean;
  }): DemoConv {
    const id = `c-${++this.convCounter}`;
    const conv: DemoConv = {
      conv: {
        id,
        channelId: params.channelId,
        rootMessageId: "",
        engineRef: `${DEMO_SESSION_PFX}${id}`,
        state: "active",
        title: params.title,
        titleSource: "auto",
        access: "ask",
        archived: false,
        deliveredSeq: 0,
        createdAt: Date.now(),
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.workspace ? { workspace: params.workspace } : {}),
        ...(params.model ? { model: params.model } : {}),
        ...(params.provider ? { provider: params.provider } : {}),
        ...(params.effort ? { effort: params.effort } : {}),
        ...(params.fast !== undefined ? { fast: params.fast } : {}),
      },
      root: undefined as unknown as AppMessage,
      messages: [],
      events: [],
      latestSeq: 0,
      prs: [],
      jobs: [],
      queued: [],
      played: true,
    };
    this.convs.set(id, conv);
    const root = this.postMessage(params.channelId, {
      text: params.text,
      authorId: params.authorId,
      authorKind: "user",
      conversationId: id,
    });
    conv.root = root;
    conv.conv = {
      ...conv.conv,
      rootMessageId: root.id,
      deliveredSeq: root.seq,
    };
    this.conversations.set([...this.conversations.get(), conv.conv]);
    this.conversationSummaries.set([
      ...this.conversationSummaries.get(),
      { conversation: conv.conv, root, last: root, messageCount: 1 },
    ]);
    this.later(() => {
      void this.playTurn(
        conv,
        firstTurnScript({
          text: params.text,
          cwd: params.cwd,
          workspace: params.workspace,
        }),
        { live: true },
      );
    }, 800);
    return conv;
  }

  /** `messages.post` on a conversation: queue behind a running turn, or
      claim immediately as the next turn. */
  deliver(conv: DemoConv, message: AppMessage): void {
    if (conv.turn && !conv.turn.dead) {
      conv.queued.push(message);
      return;
    }
    conv.conv = { ...conv.conv, deliveredSeq: message.seq };
    const hadTurns = conv.events.some((e) => e.type === "turn.started");
    this.later(() => {
      void this.playTurn(
        conv,
        hadTurns
          ? followUpScript(message.text, conv.conv.cwd)
          : firstTurnScript({
              text: message.text,
              cwd: conv.conv.cwd,
              workspace: conv.conv.workspace,
            }),
        { live: true },
      );
    }, 600);
  }

  /** `turns.interrupt` — the stop button: end the open turn and park any
      queued user messages as `dropped` (the not-sent tray, #315). */
  interrupt(conv: DemoConv): void {
    const turn = conv.turn;
    if (!turn || turn.dead) return;
    turn.dead = true;
    conv.turn = undefined;
    for (const q of conv.queued) {
      const idx = conv.messages.indexOf(q);
      if (idx >= 0) {
        conv.messages[idx] = { ...q, dropped: true };
        this.fire("message.changed", {
          channelId: q.channelId,
          message: conv.messages[idx],
        });
      }
    }
    conv.queued = [];
    /* Dead ctx emits are suppressed; the turn's log is intact. */
    const event = {
      seq: ++conv.latestSeq,
      sessionId: conv.conv.engineRef ?? DEMO_SESSION_PFX + conv.conv.id,
      type: "turn.completed",
      payload: {
        turnId: turn.turnId,
        stopReason: "cancelled",
      },
    } as EngineEvent;
    conv.events.push(event);
    conv.conv = { ...conv.conv, state: "idle" };
    this.emit(conv, "session.state", { state: "idle" });
    this.patchConversation(conv, { state: "idle" });
    const store = this.feeds.get(conv.conv.id);
    if (store) {
      const f = store.get();
      store.set({
        ...f,
        latestSeq: event.seq,
        coverageSeq: event.seq,
        events: [...f.events, event],
        snapshot: this.snapshotOf(conv),
      });
    }
  }

  snapshotOfPublic(conv: DemoConv): SessionSnapshot {
    return this.snapshotOf(conv);
  }

  settingsGet(key: string): unknown {
    return this.settings.get(key);
  }

  settingsSet(key: string, value: unknown): void {
    this.settings.set(key, value);
    this.fire("settings.changed", { key, value });
  }

  patchConversation(conv: DemoConv, patch: Partial<Conversation>): void {
    conv.conv = { ...conv.conv, ...patch };
    this.conversations.set(
      this.conversations
        .get()
        .map((c) => (c.id === conv.conv.id ? conv.conv : c)),
    );
    this.conversationSummaries.set(
      this.conversationSummaries
        .get()
        .map((s) =>
          s.conversation.id === conv.conv.id
            ? { ...s, conversation: conv.conv }
            : s,
        ),
    );
    this.fire("conversation.updated", {
      channelId: conv.conv.channelId,
      conversation: conv.conv,
    });
  }
}
