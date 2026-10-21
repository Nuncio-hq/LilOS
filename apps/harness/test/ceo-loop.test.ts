import type { Ask, Conversation, ScheduledTask } from "@lilos/contracts/app";
import { CEO_SETTING_KEY, CEO_THREAD_KEY } from "@lilos/contracts/app";
import { CEO_WAKE_COALESCE_MS } from "@lilos/contracts/harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ceoLoopReady,
  ceoOnAsk,
  ceoOnConversation,
  ceoOnSettings,
  ceoOnStuck,
  noteCeoWake,
  routeCeoSchedule,
  stopCeoLoop,
  wireCeoLoop,
} from "../src/harness/ceo-loop";
import { ceoLoop } from "../src/harness/ceo-state";
import type { HarnessCtx, SessionBinding } from "../src/harness/ctx";
import {
  beginStuckTurn,
  noteStuckTool,
  STUCK_REPEAT,
  type StuckCall,
  stopStuckWatches,
} from "../src/harness/stuck";

/**
 * D-#777: a holder change forgets the standing thread, a busy thread is
 * not steered into, one stuck episode wakes once, and a schedule is
 * stamped only once its wake has been posted.
 */

interface Call {
  method: string;
  params: Record<string, unknown>;
}

function world(opts?: {
  ceo?: string | null;
  threadId?: string;
  threadState?: Conversation["state"];
  threadEmployee?: string;
  employees?: { id: string; name?: string }[];
  failPostOnce?: { n: number };
  tickets?: { id: string; status: string }[];
  holdOpen?: Promise<void>;
}) {
  const ceo = opts?.ceo === undefined ? "ceo" : opts.ceo;
  const calls: Call[] = [];
  const convs = new Map<string, Conversation>();
  const channels = [
    { id: "ch-ceo", kind: "dm" as const, employeeId: "ceo" },
    { id: "ch-b", kind: "dm" as const, employeeId: "b" },
    { id: "ch-owner", kind: "dm" as const, employeeId: "owner" },
    { id: "ch-other", kind: "dm" as const, employeeId: "other" },
  ];
  if (opts?.threadId) {
    const employee = opts.threadEmployee ?? "ceo";
    const channel = channels.find((c) => c.employeeId === employee);
    convs.set(opts.threadId, {
      id: opts.threadId,
      channelId: channel?.id ?? "ch-ceo",
      title: "CEO",
      state: opts.threadState ?? "idle",
      archived: false,
    } as Conversation);
  }
  const employees = opts?.employees ?? [
    { id: "ceo" },
    { id: "owner" },
    { id: "other", name: "Other" },
  ];
  const bindings = new Map<string, SessionBinding>();
  const inFlightDeliveries = new Map<string, number>();
  const ctx = {
    bindings,
    inFlightDeliveries,
    conversationFromAtom: (id: string) => convs.get(id),
    employeeIdFor: (conv?: { channelId: string }) =>
      channels.find((c) => c.id === conv?.channelId)?.employeeId,
    updateConversation: async () => {},
    opts: {
      log: { warn: () => {} },
      relay: {
        channels: { get: () => channels },
        employees: { get: () => employees },
        tickets: { get: () => opts?.tickets ?? [] },
        request: async (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params: params ?? {} });
          if (method === "settings.get") {
            if (params.key === CEO_SETTING_KEY) return { value: ceo };
            if (params.key === CEO_THREAD_KEY)
              return { value: opts?.threadId ?? null };
            return { value: null };
          }
          if (method === "messages.post") {
            if (opts?.failPostOnce && opts.failPostOnce.n === 0) {
              opts.failPostOnce.n = 1;
              throw new Error("post failed");
            }
            return { message: { id: "m1" } };
          }
          if (method === "conversations.open") {
            if (opts?.holdOpen) await opts.holdOpen;
            const id = `opened-${calls.length}`;
            const conv = {
              id,
              channelId: params.channelId as string,
              title: params.title as string,
              state: "idle",
              archived: false,
              ...(params.ceoWake === true ? { ceoThread: true as const } : {}),
            } as Conversation;
            convs.set(id, conv);
            return { conversation: conv };
          }
          if (method === "channels.openDm") {
            return {
              channel: {
                id: "ch-new",
                kind: "dm",
                employeeId: params.employeeId,
              },
            };
          }
          return { ok: true };
        },
      },
    },
  } as unknown as HarnessCtx;
  return { ctx, calls, convs, bindings };
}

async function boot(ctx: HarnessCtx) {
  wireCeoLoop(ctx);
  await ceoLoopReady(ctx);
}

async function micro() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

async function fire() {
  await vi.advanceTimersByTimeAsync(CEO_WAKE_COALESCE_MS);
  await micro();
}

const posted = (calls: Call[]) =>
  calls.filter(
    (c) => c.method === "messages.post" || c.method === "conversations.open",
  );

const search = (at: number): StuckCall => ({
  tool: "web_search",
  input: { query: "journaling" },
  at,
});

describe("CEO loop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("forgets the standing thread when the holder changes, and does not dedupe", async () => {
    vi.useFakeTimers();
    const { ctx, calls } = world({ threadId: "old", threadEmployee: "ceo" });
    await boot(ctx);
    ceoOnSettings(ctx, { key: CEO_SETTING_KEY, value: "b" });
    expect(
      calls.some((c) => c.method === "settings.set" && c.params.value === null),
    ).toBe(true);
    await noteCeoWake(ctx, { reason: "done", ticketId: "T-1" });
    await fire();
    const open = calls.find((c) => c.method === "conversations.open");
    expect(open?.params.channelId).toBe("ch-b");
    expect(open?.params).not.toHaveProperty("dedupeKey");
    expect(open?.params.authorKind).toBe("system");
    expect(open?.params.titleSource).toBe("user");
    expect(open?.params.title).toBe("CEO");
    expect(String(open?.params.text).startsWith("CEO wake.")).toBe(true);
    expect(open?.params.ceoWake).toBe(true);
    expect(calls.some((c) => c.method === "messages.post")).toBe(false);
  });

  it("clears a pending wake and the timer when the seat is empty", async () => {
    vi.useFakeTimers();
    const { ctx, calls } = world();
    await boot(ctx);
    await noteCeoWake(ctx, { reason: "done", ticketId: "T-1" });
    ceoOnSettings(ctx, { key: CEO_SETTING_KEY, value: null });
    await fire();
    expect(posted(calls)).toHaveLength(0);
  });

  it("does not reuse a thread that belongs to someone else", async () => {
    vi.useFakeTimers();
    const { ctx, calls } = world({
      threadId: "theirs",
      threadEmployee: "other",
    });
    await boot(ctx);
    await noteCeoWake(ctx, { reason: "done", ticketId: "T-1" });
    await fire();
    const open = calls.find((c) => c.method === "conversations.open");
    expect(open?.params.channelId).toBe("ch-ceo");
    expect(
      calls.some(
        (c) =>
          c.method === "messages.post" && c.params.conversationId === "theirs",
      ),
    ).toBe(false);
  });

  it("waits out a running turn, including one it did not start", async () => {
    vi.useFakeTimers();
    const { ctx, calls, convs, bindings } = world({
      threadId: "t1",
      threadState: "idle",
    });
    bindings.set("t1", {
      queue: [{ id: "queued" }],
      inflightPrompts: new Set<string>(),
    } as unknown as SessionBinding);
    await boot(ctx);
    await noteCeoWake(ctx, { reason: "done", ticketId: "T-1" });
    await fire();
    expect(posted(calls)).toHaveLength(0);
    const conv = convs.get("t1");
    const binding = bindings.get("t1");
    if (!conv || !binding) throw new Error("missing thread");
    binding.queue = [];
    ceoOnConversation(ctx, { ...conv, state: "idle" });
    await micro();
    const post = calls.find((c) => c.method === "messages.post");
    expect(post?.params.authorKind).toBe("system");
    expect(post?.params.authorId).toBe("system");
    expect(String(post?.params.text).startsWith("CEO wake.")).toBe(true);
    expect(post?.params.ceoWake).toBe(true);
  });

  it("re-arms after a failed post", async () => {
    vi.useFakeTimers();
    const failPostOnce = { n: 0 };
    const { ctx, calls } = world({ threadId: "t1", failPostOnce });
    await boot(ctx);
    await noteCeoWake(ctx, { reason: "done", ticketId: "T-1" });
    await fire();
    expect(calls.filter((c) => c.method === "messages.post")).toHaveLength(1);
    await fire();
    expect(calls.filter((c) => c.method === "messages.post")).toHaveLength(2);
  });

  it("stop drops the coalesce timer", async () => {
    vi.useFakeTimers();
    const { ctx, calls } = world();
    await boot(ctx);
    await noteCeoWake(ctx, { reason: "done", ticketId: "T-1" });
    stopCeoLoop(ctx);
    await vi.advanceTimersByTimeAsync(CEO_WAKE_COALESCE_MS * 2);
    await micro();
    expect(posted(calls)).toHaveLength(0);
  });

  it("wakes once when a thread becomes stuck, and prefers a worker over the CEO", async () => {
    vi.useFakeTimers();
    const { ctx, calls, convs } = world();
    await boot(ctx);
    const conv = {
      id: "stuck",
      channelId: "ch-owner",
      ticketId: "T-1",
      title: "Stuck step",
      state: "idle",
      archived: false,
    } as Conversation;
    convs.set(conv.id, conv);
    const binding = {
      conversationId: conv.id,
      channelId: conv.channelId,
      employeeId: "owner",
      runningTurnId: "turn",
      stopRequested: false,
      nowWaits: new Map<string, string>(),
      textByTurn: new Map<string, string>(),
    } as SessionBinding;
    beginStuckTurn(ctx, binding, 0);
    for (let i = 0; i < STUCK_REPEAT; i++)
      noteStuckTool(ctx, binding, search(i), false);
    await micro();
    await fire();
    expect(posted(calls)).toHaveLength(1);
    const first = posted(calls)[0];
    expect(String(first?.params.text)).toContain(
      "stuck ticket T-1 hand other name:Other",
    );
    expect(String(first?.params.text)).not.toContain(" last");
    const standing = [...convs.values()].find((c) => c.title === "CEO");
    if (!standing) throw new Error("missing standing thread");
    ceoOnConversation(ctx, { ...standing, state: "active" });
    ceoOnConversation(ctx, { ...standing, state: "idle" });
    await micro();
    noteStuckTool(ctx, binding, search(STUCK_REPEAT), false);
    await micro();
    await fire();
    expect(posted(calls)).toHaveLength(1);
    stopStuckWatches([binding]);
  });

  it("hands a stuck thread to the CEO only as a last resort, and says so", async () => {
    vi.useFakeTimers();
    const { ctx, calls, convs } = world({
      employees: [{ id: "ceo" }, { id: "owner" }],
    });
    await boot(ctx);
    const conv = {
      id: "stuck",
      channelId: "ch-owner",
      ticketId: "T-2",
      title: "Stuck",
      state: "idle",
      archived: false,
    } as Conversation;
    convs.set(conv.id, conv);
    await ceoOnStuck(ctx, {
      conversationId: conv.id,
      employeeId: "ceo",
    } as SessionBinding);
    await fire();
    expect(posted(calls)).toHaveLength(0);
    await ceoOnStuck(ctx, {
      conversationId: conv.id,
      employeeId: "owner",
    } as SessionBinding);
    await fire();
    const text = String(posted(calls)[0]?.params.text);
    expect(text).toContain("stuck ticket T-2 hand ceo last");
  });

  it("ignores a cancelled ask and an ask in the CEO's own thread", async () => {
    vi.useFakeTimers();
    const { ctx, calls, convs } = world({ threadId: "standing" });
    await boot(ctx);
    ceoOnAsk(ctx, {
      outcome: "cancel",
      conversationId: "anywhere",
    } as Ask);
    convs.set("own", {
      id: "own",
      channelId: "ch-ceo",
      ticketId: "T-3",
      state: "idle",
      archived: false,
    } as Conversation);
    ceoOnAsk(ctx, { conversationId: "own" } as Ask);
    ceoOnAsk(ctx, { conversationId: "standing" } as Ask);
    await fire();
    expect(posted(calls)).toHaveLength(0);
  });

  it("stamps a schedule only after its wake is posted", async () => {
    vi.useFakeTimers();
    const { ctx, calls } = world({ threadId: "t1" });
    await boot(ctx);
    const consumed = await routeCeoSchedule(ctx, {
      id: "task1",
      employeeId: "ceo",
      name: "Morning",
      prompt: "Look",
    } as ScheduledTask);
    expect(consumed).toBe(true);
    expect(calls.some((c) => c.method === "schedules.update")).toBe(false);
    await fire();
    const postAt = calls.findIndex((c) => c.method === "messages.post");
    const stampAt = calls.findIndex((c) => c.method === "schedules.update");
    expect(postAt).toBeGreaterThanOrEqual(0);
    expect(stampAt).toBeGreaterThan(postAt);
    const stamp = calls[stampAt];
    expect(stamp?.params.id).toBe("task1");
    expect(stamp?.params.lastRun).toBeUndefined();
    const other = await routeCeoSchedule(ctx, {
      id: "task2",
      employeeId: "owner",
      name: "Nope",
      prompt: "no",
    } as ScheduledTask);
    expect(other).toBe(false);
  });

  it("wakes when a worker finishes with the ticket still open", async () => {
    vi.useFakeTimers();
    const { ctx, calls, convs, bindings } = world({
      tickets: [{ id: "T-9", status: "working" }],
    });
    await boot(ctx);
    const conv = {
      id: "work",
      channelId: "ch-owner",
      ticketId: "T-9",
      title: "Page",
      state: "active",
      archived: false,
    } as Conversation;
    convs.set(conv.id, conv);
    bindings.set(conv.id, {
      conversationId: conv.id,
      employeeId: "owner",
    } as SessionBinding);
    ceoOnConversation(ctx, { ...conv, state: "idle" });
    await fire();
    expect(posted(calls)).toHaveLength(1);
    const text = String(posted(calls)[0]?.params.text);
    expect(text).toContain(
      "ticket T-9 still open after the thread finished: check it, then close it or hand it on",
    );
    expect(posted(calls)[0]?.params.ceoWake).toBe(true);

    /* The CEO's own thread, a turn that called ticket_update, and a
       ticket already done do not wake. */
    const own = {
      ...conv,
      id: "own",
      channelId: "ch-ceo",
      state: "active" as const,
    };
    convs.set(own.id, own);
    ceoOnConversation(ctx, { ...own, state: "idle" });
    const worker = bindings.get(conv.id);
    if (!worker) throw new Error("missing worker binding");
    worker.ticketTouched = true;
    convs.set(conv.id, { ...conv, state: "active" });
    ceoOnConversation(ctx, { ...conv, state: "idle" });
    expect(ceoLoop(ctx).wakes.hasPending).toBe(false);
    expect(posted(calls)).toHaveLength(1);
  });

  it("settles a wake whose prompt fails before the turn starts", async () => {
    vi.useFakeTimers();
    const { ctx, calls, convs } = world({ threadId: "t1" });
    await boot(ctx);
    await noteCeoWake(ctx, { reason: "done", ticketId: "T-1" });
    await fire();
    expect(posted(calls)).toHaveLength(1);
    await noteCeoWake(ctx, { reason: "ask", ticketId: "T-2" });
    const standing = convs.get("t1");
    if (!standing) throw new Error("missing standing thread");
    ceoOnConversation(ctx, {
      ...standing,
      state: "idle",
      turnFailure: { kind: "generic", text: "prompt failed" },
    });
    await micro();
    expect(posted(calls)).toHaveLength(2);
    expect(String(posted(calls)[1]?.params.text)).toContain("ask ticket T-2");
  });

  it("does not stamp the previous CEO's thread when the holder changes during open", async () => {
    vi.useFakeTimers();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { ctx, calls } = world({ holdOpen: held });
    await boot(ctx);
    await noteCeoWake(ctx, { reason: "done", ticketId: "T-1" });
    const started = vi.advanceTimersByTimeAsync(CEO_WAKE_COALESCE_MS);
    await micro();
    ceoOnSettings(ctx, { key: CEO_SETTING_KEY, value: "b" });
    release();
    await started;
    await micro();
    expect(ceoLoop(ctx).threadId).toBeUndefined();
    expect(
      calls.some(
        (c) =>
          c.method === "settings.set" &&
          c.params.key === CEO_THREAD_KEY &&
          typeof c.params.value === "string",
      ),
    ).toBe(false);
  });
});
