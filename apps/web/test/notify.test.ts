/**
 * Issue #32 — AC-1 + AC-2 renderer logic: engine events become desktop
 * notifications only for conversations Oscar is not looking at, and every
 * notification carries the conversation it belongs to so a click can open it.
 * Pure/injected deps — the Electron sink is a stub here; the real
 * Notification + click path is covered in apps/desktop/test.
 */

import type {
  AppChannel,
  Conversation,
  DesktopNotification,
  Employee,
} from "@lilos/contracts/app";
import type { EngineEvent, EngineRequest } from "@lilos/contracts/engine";
import { describe, expect, it, vi } from "vitest";
import {
  notificationForEvent,
  openConversationFromPath,
  routeForConversation,
  watchNotifications,
} from "../src/lib/notify";

const employee: Employee = {
  id: "e1",
  name: "Builder",
  role: "engineer",
  status: "online",
  profile: "default",
  model: "",
  now: "",
  instructions: "",
  respondTo: "me",
  createdAt: 0,
};

const channel: AppChannel = {
  id: "ch1",
  kind: "dm",
  employeeId: "e1",
  lastSeq: 0,
  createdAt: 0,
};

const conv = (id: string, engineRef: string | null): Conversation => ({
  id,
  channelId: "ch1",
  rootMessageId: `m-${id}`,
  engineRef,
  state: "active",
  title: "Ship the thing",
  archived: false,
  deliveredSeq: 0,
  createdAt: 0,
});

const ctx = (...convs: Conversation[]) => ({
  conversations: convs,
  channels: [channel],
  employees: [employee],
});

const approval: EngineRequest = {
  kind: "approval",
  command: "git push",
  options: ["once", "always", "deny"],
};

const question: EngineRequest = {
  kind: "question",
  question: "Which region should I deploy to?",
};

const ev = <T extends EngineEvent["type"]>(
  type: T,
  sessionId: string,
  payload: Extract<EngineEvent, { type: T }>["payload"],
): EngineEvent => ({ seq: 7, sessionId, type, payload }) as EngineEvent;

describe("AC-1 notificationForEvent", () => {
  it("done: a completed turn notifies with the conversation's employee", () => {
    const n = notificationForEvent(
      ev("turn.completed", "s1", { turnId: "t1", stopReason: "end_turn" }),
      ctx(conv("c1", "s1")),
    );
    expect(n).toEqual({
      conversationId: "c1",
      kind: "done",
      title: "Builder finished",
      body: "Ship the thing",
    });
  });

  it("needs approval: request.opened notifies with the command as the body", () => {
    const n = notificationForEvent(
      ev("request.opened", "s1", {
        turnId: "t1",
        requestId: "r1",
        request: approval,
      }),
      ctx(conv("c1", "s1")),
    );
    expect(n?.kind).toBe("ask");
    expect(n?.title).toBe("Builder needs your approval");
    expect(n?.body).toBe("git push");
  });

  it("question ask notifies with the question as the body", () => {
    const n = notificationForEvent(
      ev("request.opened", "s1", {
        turnId: "t1",
        requestId: "r1",
        request: question,
      }),
      ctx(conv("c1", "s1")),
    );
    expect(n?.title).toBe("Builder has a question");
    expect(n?.body).toBe("Which region should I deploy to?");
  });

  it("failed: turn.completed with an error notifies", () => {
    const n = notificationForEvent(
      ev("turn.completed", "s1", {
        turnId: "t1",
        stopReason: "refusal",
        error: "engine exploded",
      }),
      ctx(conv("c1", "s1")),
    );
    expect(n?.kind).toBe("failed");
    expect(n?.title).toBe("Builder hit a problem");
    expect(n?.body).toBe("engine exploded");
  });

  it("failed: session.state error notifies", () => {
    const n = notificationForEvent(
      ev("session.state", "s1", { state: "error", reason: "lost the model" }),
      ctx(conv("c1", "s1")),
    );
    expect(n?.kind).toBe("failed");
    expect(n?.body).toBe("lost the model");
  });

  it("ignores events that are not attention-worthy", () => {
    const c = ctx(conv("c1", "s1"));
    for (const e of [
      ev("turn.completed", "s1", { turnId: "t1", stopReason: "cancelled" }),
      ev("turn.started", "s1", { turnId: "t1" }),
      ev("turn.delta", "s1", {
        turnId: "t1",
        stream: "text",
        delta: "hi",
      }),
      ev("session.state", "s1", { state: "running" }),
      ev("tool.started", "s1", {
        turnId: "t1",
        toolCallId: "c1",
        tool: "read",
        input: {},
      }),
      ev("request.resolved", "s1", { requestId: "r1", outcome: "once" }),
    ]) {
      expect(notificationForEvent(e, c)).toBeNull();
    }
  });

  it("max_tokens without an error still counts as done, not failed", () => {
    const n = notificationForEvent(
      ev("turn.completed", "s1", {
        turnId: "t1",
        stopReason: "max_tokens",
      }),
      ctx(conv("c1", "s1")),
    );
    expect(n?.kind).toBe("done");
  });

  it("drops events for sessions with no conversation mapping", () => {
    const n = notificationForEvent(
      ev("turn.completed", "ghost", {
        turnId: "t1",
        stopReason: "end_turn",
      }),
      ctx(conv("c1", "s1")),
    );
    expect(n).toBeNull();
  });
});

describe("AC-1 watchNotifications — only when the conversation is not in view", () => {
  const harness = () => {
    const posted: DesktopNotification[] = [];
    const listeners = new Set<(e: EngineEvent) => void>();
    const state = {
      posted,
      openConv: null as string | null,
      foreground: true,
      convs: [conv("c1", "s1"), conv("c2", "s2")],
    };
    const stop = watchNotifications({
      onEvent: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      context: () => ctx(...state.convs),
      openConversationId: () => state.openConv,
      inForeground: () => state.foreground,
      post: (n) => posted.push(n),
    });
    const emit = (e: EngineEvent) => {
      for (const fn of listeners) fn(e);
    };
    return { posted, state, emit, stop };
  };

  it("suppresses the notification while that conversation is open and focused", () => {
    const { posted, state, emit } = harness();
    state.openConv = "c1";
    state.foreground = true;
    emit(ev("turn.completed", "s1", { turnId: "t1", stopReason: "end_turn" }));
    expect(posted).toEqual([]);
  });

  it("notifies when a different conversation is in view", () => {
    const { posted, state, emit } = harness();
    state.openConv = "c2";
    emit(ev("turn.completed", "s1", { turnId: "t1", stopReason: "end_turn" }));
    expect(posted.map((n) => n.conversationId)).toEqual(["c1"]);
  });

  it("notifies when the app is unfocused even if the conversation is open", () => {
    const { posted, state, emit } = harness();
    state.openConv = "c1";
    state.foreground = false;
    emit(ev("turn.completed", "s1", { turnId: "t1", stopReason: "end_turn" }));
    expect(posted.map((n) => n.conversationId)).toEqual(["c1"]);
  });

  it("collapses the failure pair (turn.completed error + session.state error) into one", () => {
    const { posted, emit } = harness();
    emit(
      ev("turn.completed", "s1", {
        turnId: "t1",
        stopReason: "refusal",
        error: "boom",
      }),
    );
    emit(ev("session.state", "s1", { state: "error", reason: "boom" }));
    expect(posted).toHaveLength(1);
  });

  it("retries once when the session→conversation mapping lands late", async () => {
    vi.useFakeTimers();
    try {
      const posted: DesktopNotification[] = [];
      const listeners = new Set<(e: EngineEvent) => void>();
      const convs: Conversation[] = [];
      watchNotifications({
        onEvent: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        context: () => ctx(...convs),
        openConversationId: () => null,
        inForeground: () => true,
        post: (n) => posted.push(n),
        retryMs: 100,
      });
      for (const fn of listeners)
        fn(
          ev("turn.completed", "s-late", {
            turnId: "t1",
            stopReason: "end_turn",
          }),
        );
      expect(posted).toEqual([]);
      convs.push(conv("c-late", "s-late"));
      await vi.advanceTimersByTimeAsync(150);
      expect(posted.map((n) => n.conversationId)).toEqual(["c-late"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a request.opened that already resolved in the retry window", async () => {
    vi.useFakeTimers();
    try {
      const posted: DesktopNotification[] = [];
      const listeners = new Set<(e: EngineEvent) => void>();
      const convs: Conversation[] = [];
      let open = true;
      watchNotifications({
        onEvent: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        context: () => ctx(...convs),
        openConversationId: () => null,
        inForeground: () => true,
        isRequestOpen: () => open,
        post: (n) => posted.push(n),
        retryMs: 100,
      });
      for (const fn of listeners)
        fn(
          ev("request.opened", "s-fast", {
            turnId: "t1",
            requestId: "r1",
            request: approval,
          }),
        );
      open = false;
      convs.push(conv("c-fast", "s-fast"));
      await vi.advanceTimersByTimeAsync(150);
      expect(posted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never retries a cancelled turn once its conversation is known", async () => {
    vi.useFakeTimers();
    try {
      const posted: DesktopNotification[] = [];
      const listeners = new Set<(e: EngineEvent) => void>();
      watchNotifications({
        onEvent: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        context: () => ctx(conv("c1", "s1")),
        openConversationId: () => null,
        inForeground: () => true,
        post: (n) => posted.push(n),
        retryMs: 100,
      });
      for (const fn of listeners)
        fn(
          ev("turn.completed", "s1", {
            turnId: "t1",
            stopReason: "cancelled",
          }),
        );
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(150);
      expect(posted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AC-2 open the exact conversation", () => {
  it("maps the notification's conversation to its DM route", () => {
    expect(routeForConversation("c1", ctx(conv("c1", "s1")))).toEqual({
      employeeId: "e1",
      conversationId: "c1",
    });
    expect(routeForConversation("nope", ctx(conv("c1", "s1")))).toBeNull();
  });

  it("reads the open conversation from the route", () => {
    expect(openConversationFromPath("/dm/e1/c1")).toBe("c1");
    expect(openConversationFromPath("/dm/e1")).toBeNull();
    expect(openConversationFromPath("/")).toBeNull();
  });
});
