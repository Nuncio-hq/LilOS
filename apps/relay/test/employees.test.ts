import { FakeEngine, handleJsonRpc } from "@lilos/engine-fake";
import { describe, expect, it } from "vitest";
import { createRelay, type RelayWsPeer } from "../src/session";
import { createMemoryStore } from "../src/store";

/**
 * Issue #29 — relay-side employee lifecycle + engine passthrough.
 *
 * `agents.*` / `models.*` are engine-protocol calls the relay forwards
 * verbatim to the registered engine host as a JSON-RPC request; here the
 * host peer dispatches them into a real FakeEngine (the same
 * `handleJsonRpc` the WebSocket adapter and the Hermes adapter use), so the
 * round trip user → relay → host → engine is exercised end to end.
 *
 * `employees.remove` deletes only the LilOS record + DM graph — the engine
 * profile is never touched (there is no profile-delete call anywhere).
 */

const TOKEN = "test-token";

function connectPeer(relay: ReturnType<typeof createRelay>) {
  const frames: unknown[] = [];
  const peer: RelayWsPeer = {
    send: (frame) => frames.push(JSON.parse(frame)),
    close: () => {},
  };
  const connection = relay.connect(peer);
  return { frames, connection };
}

const eventsNamed = (frames: unknown[], method: string) =>
  (frames as { method?: string; params?: unknown }[]).filter(
    (f) => f.method === method,
  );
const resultOf = (frames: unknown[], id: string) => {
  const frame = (
    frames as {
      id?: string;
      result?: unknown;
      error?: { code: number; message: string; data?: Record<string, unknown> };
    }[]
  ).find((f) => f.id === id);
  if (!frame) throw new Error(`no response frame for ${id}`);
  return frame;
};
const errorData = (frames: unknown[], id: string) => {
  const { error } = resultOf(frames, id);
  if (!error) throw new Error(`expected an error frame for ${id}`);
  return error.data?.code as string;
};

let nextId = 0;
const req = (method: string, params: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id: `t${nextId++}`, method, params });
const lastId = () => `t${nextId - 1}`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Send a request and wait for the (possibly host-forwarded) response frame. */
const call = async (
  connection: { receive(d: string): Promise<void> },
  frames: unknown[],
  method: string,
  params: Record<string, unknown> = {},
) => {
  await connection.receive(req(method, params));
  await tick();
  return resultOf(frames, lastId());
};

const newRelay = () =>
  createRelay({ store: createMemoryStore(), token: TOKEN });

async function helloed(relay: ReturnType<typeof createRelay>) {
  const { frames, connection } = connectPeer(relay);
  await connection.receive(
    req("session.hello", { protocolVersion: 1, token: TOKEN }),
  );
  frames.length = 0;
  return { frames, connection };
}

/**
 * A helloed peer registered as the engine host whose forwarded requests are
 * dispatched to a real FakeEngine and answered back through the relay.
 */
async function engineHost(
  relay: ReturnType<typeof createRelay>,
  engine = new FakeEngine(),
) {
  const frames: unknown[] = [];
  const requests: { id: string; method: string }[] = [];
  let connection!: { receive(d: string): Promise<void>; closed(): void };
  const peer: RelayWsPeer = {
    send: (frame) => {
      const parsed = JSON.parse(frame) as {
        id?: string;
        method?: string;
      };
      frames.push(parsed);
      if (typeof parsed.method === "string" && parsed.id !== undefined) {
        requests.push({ id: parsed.id, method: parsed.method });
        void handleJsonRpc(engine, frame).then((res) => {
          if (res) void connection.receive(res);
        });
      }
    },
    close: () => {},
  };
  connection = relay.connect(peer);
  await connection.receive(
    req("session.hello", { protocolVersion: 1, token: TOKEN }),
  );
  await connection.receive(req("harness.register", {}));
  frames.length = 0;
  return { frames, requests, connection, engine };
}

async function hire(
  connection: { receive(d: string): Promise<void> },
  frames: unknown[],
  name = "Ada",
  profile = "reviewer",
) {
  await connection.receive(
    req("employees.create", { name, role: "reviewer", profile }),
  );
  const { employee } = resultOf(frames, lastId()).result as {
    employee: { id: string };
  };
  await connection.receive(req("channels.openDm", { employeeId: employee.id }));
  const { channel } = resultOf(frames, lastId()).result as {
    channel: { id: string };
  };
  return { employee, channel };
}

describe("employees lifecycle + engine passthrough (#29)", () => {
  it("AC-1 agents.list/describe + models.list reach the engine host verbatim", async () => {
    const relay = newRelay();
    const host = await engineHost(relay);
    const user = await helloed(relay);

    const { agents } = (await call(user.connection, user.frames, "agents.list"))
      .result as {
      agents: {
        id: string;
        name: string;
        model: string;
        skillCount: number;
        soul?: string;
      }[];
    };
    expect(agents.map((a) => a.id).sort()).toEqual([
      "builder",
      "marketer",
      "reviewer",
    ]);
    expect(agents.find((a) => a.id === "builder")?.skillCount).toBe(9);
    expect(agents[0]?.soul).toBeUndefined(); // persona text is describe-only

    const { agent } = (
      await call(user.connection, user.frames, "agents.describe", {
        id: "builder",
      })
    ).result as {
      agent: { id: string; soul?: string };
    };
    expect(agent.soul).toContain("Builder");

    const { models } = (await call(user.connection, user.frames, "models.list"))
      .result as {
      models: { id: string }[];
    };
    expect(models.map((m) => m.id)).toContain("fake-large");

    expect(host.requests.map((r) => r.method)).toEqual([
      "agents.list",
      "agents.describe",
      "models.list",
    ]);
  });

  it("AC-2 agents.create makes a real profile; employees.create then hires it", async () => {
    const relay = newRelay();
    await engineHost(relay);
    const user = await helloed(relay);

    const { agent } = (
      await call(user.connection, user.frames, "agents.create", {
        name: "tester",
        description: "QA",
        soul: "You are Tester. Break things kindly.",
        model: "fake-small",
      })
    ).result as {
      agent: { id: string; name: string };
    };
    expect(agent).toMatchObject({ id: "tester", name: "tester" });

    await user.connection.receive(
      req("employees.create", {
        name: "Tester",
        role: "QA",
        profile: "tester",
      }),
    );
    const { employee } = resultOf(user.frames, lastId()).result as {
      employee: { id: string; profile: string };
    };
    expect(employee.profile).toBe("tester");

    const { agents } = (await call(user.connection, user.frames, "agents.list"))
      .result as {
      agents: { id: string }[];
    };
    expect(agents.map((a) => a.id)).toContain("tester");
  });

  it("AC-3 employees.update edits display name + role", async () => {
    const relay = newRelay();
    await engineHost(relay);
    const user = await helloed(relay);
    const { employee } = await hire(user.connection, user.frames);

    await user.connection.receive(
      req("employees.update", {
        id: employee.id,
        name: "Ada Lovelace",
        role: "principal engineer",
      }),
    );
    const updated = resultOf(user.frames, lastId()).result as {
      employee: { name: string; role: string; profile: string };
    };
    expect(updated.employee).toMatchObject({
      name: "Ada Lovelace",
      role: "principal engineer",
      profile: "reviewer",
    });
  });

  it("AC-4 employees.remove drops the record + DM graph; the engine profile stays", async () => {
    const relay = newRelay();
    await engineHost(relay);
    const user = await helloed(relay);
    const { employee, channel } = await hire(user.connection, user.frames);

    await user.connection.receive(
      req("conversations.open", { channelId: channel.id, text: "hi" }),
    );
    const { conversation } = resultOf(user.frames, lastId()).result as {
      conversation: { id: string };
    };
    await user.connection.receive(
      req("messages.post", {
        channelId: channel.id,
        conversationId: conversation.id,
        text: "hello?",
        authorKind: "user",
      }),
    );
    await user.connection.receive(
      req("channel.subscribe", { channelId: channel.id }),
    );

    await user.connection.receive(req("employees.remove", { id: employee.id }));
    expect(resultOf(user.frames, lastId()).result).toEqual({ ok: true });

    await user.connection.receive(req("employees.list"));
    expect(
      (resultOf(user.frames, lastId()).result as { employees: unknown[] })
        .employees,
    ).toEqual([]);
    await user.connection.receive(req("channels.list"));
    expect(
      (resultOf(user.frames, lastId()).result as { channels: unknown[] })
        .channels,
    ).toEqual([]);
    await user.connection.receive(req("conversations.list"));
    expect(
      (resultOf(user.frames, lastId()).result as { conversations: unknown[] })
        .conversations,
    ).toEqual([]);

    // The engine profile is untouched — removal never calls into the engine.
    const { agents } = (await call(user.connection, user.frames, "agents.list"))
      .result as {
      agents: { id: string }[];
    };
    expect(agents.map((a) => a.id)).toContain("reviewer");
  });

  it("broadcasts employee.upserted on hire/edit and employee.removed + channel.removed on remove", async () => {
    const relay = newRelay();
    await engineHost(relay);
    const user = await helloed(relay);
    const watcher = await helloed(relay);

    const { employee, channel } = await hire(user.connection, user.frames);
    expect(eventsNamed(watcher.frames, "employee.upserted").length).toBe(1);

    await user.connection.receive(
      req("employees.update", { id: employee.id, name: "Renamed" }),
    );
    expect(eventsNamed(watcher.frames, "employee.upserted").length).toBe(2);

    watcher.frames.length = 0;
    await user.connection.receive(req("employees.remove", { id: employee.id }));
    const removed = eventsNamed(watcher.frames, "employee.removed");
    expect(removed).toHaveLength(1);
    expect(removed[0]?.params).toEqual({ employeeId: employee.id });
    const chRemoved = eventsNamed(watcher.frames, "channel.removed");
    expect(chRemoved).toHaveLength(1);
    expect(chRemoved[0]?.params).toEqual({ channelId: channel.id });
  });

  it("employees.remove of an unknown id → not_found", async () => {
    const relay = newRelay();
    await engineHost(relay);
    const user = await helloed(relay);
    await user.connection.receive(
      req("employees.remove", { id: "emp_nobody" }),
    );
    expect(errorData(user.frames, lastId())).toBe("not_found");
  });

  it("agents.* without a registered host → engine_unavailable", async () => {
    const relay = newRelay();
    const user = await helloed(relay);
    await call(user.connection, user.frames, "agents.list");
    expect(errorData(user.frames, lastId())).toBe("engine_unavailable");
  });

  it("a forwarded call fails engine_unavailable when the host disconnects", async () => {
    const relay = newRelay();
    const host = await engineHost(relay);
    const user = await helloed(relay);
    await host.connection.closed();

    await call(user.connection, user.frames, "agents.list");
    expect(errorData(user.frames, lastId())).toBe("engine_unavailable");
  });

  it("an engine-side error reaches the caller as engine_error", async () => {
    const relay = newRelay();
    await engineHost(relay);
    const user = await helloed(relay);
    await call(user.connection, user.frames, "agents.describe", {
      id: "ghost",
    });
    expect(errorData(user.frames, lastId())).toBe("engine_error");
  });

  it("unhelloed peers cannot call engine methods", async () => {
    const relay = newRelay();
    await engineHost(relay);
    const raw = connectPeer(relay);
    await raw.connection.receive(req("agents.list"));
    expect(errorData(raw.frames, lastId())).toBe("unauthenticated");
  });
});
