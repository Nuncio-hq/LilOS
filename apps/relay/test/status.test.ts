import type { SystemStatusResult } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { createRelay, type RelayWsPeer } from "../src/session";
import { createMemoryStore } from "../src/store";

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
const errorOf = (frames: unknown[], id: string) => {
  const { error } = resultOf(frames, id);
  if (!error) throw new Error(`expected an error frame for ${id}`);
  return error;
};

let nextId = 0;
const req = (method: string, params: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id: `t${nextId++}`, method, params });

async function helloed(relay: ReturnType<typeof createRelay>) {
  const { frames, connection } = connectPeer(relay);
  await connection.receive(
    req("session.hello", { protocolVersion: 1, token: TOKEN }),
  );
  frames.length = 0;
  return { frames, connection };
}

const newRelay = (opts: { protocolVersion?: number } = {}) =>
  createRelay({ store: createMemoryStore(), token: TOKEN, ...opts });

async function systemStatus(
  connection: { receive(d: string): Promise<void> },
  frames: unknown[],
  params: Record<string, unknown> = {},
): Promise<SystemStatusResult> {
  await connection.receive(req("system.status", params));
  return resultOf(frames, `t${nextId - 1}`).result as SystemStatusResult;
}

const leg = (status: SystemStatusResult, id: string) => {
  const c = status.components.find((x) => x.id === id);
  if (!c) throw new Error(`missing status component ${id}`);
  return c;
};

/** A helloed peer that registers as the engine host. */
async function registerHarness(
  relay: ReturnType<typeof createRelay>,
  params: Record<string, unknown> = {},
) {
  const { frames, connection } = await helloed(relay);
  await connection.receive(
    req("harness.register", {
      protocolVersion: 1,
      version: "0.1.0",
      ...params,
    }),
  );
  return { frames, connection };
}

describe("AC-1 (#33) system.status probes each leg with state + reason", () => {
  it("all four legs ok once a harness is registered and reporting", async () => {
    const relay = newRelay();
    const host = await registerHarness(relay);
    await host.connection.receive(
      req("harness.report", {
        engine: { state: "running", detail: "engine-fake" },
        status: { model: "fake-model-1", engineName: "engine-fake" },
      }),
    );

    const app = await helloed(relay);
    const status = await systemStatus(app.connection, app.frames);
    expect(status.components.map((c) => c.id)).toEqual([
      "relay",
      "harness",
      "engine",
      "model",
    ]);
    for (const c of status.components) {
      expect(c.state).toBe("ok");
      expect(c.reason.length).toBeGreaterThan(0);
    }
    expect(leg(status, "model").reason).toContain("fake-model-1");
  });

  it("harness leg down when nothing registered; engine + model report why", async () => {
    const relay = newRelay();
    const app = await helloed(relay);
    const status = await systemStatus(app.connection, app.frames);
    expect(leg(status, "relay").state).toBe("ok");
    expect(leg(status, "harness").state).toBe("down");
    expect(leg(status, "engine").state).toBe("down");
    expect(leg(status, "model").state).toBe("down");
    expect(leg(status, "engine").reason.toLowerCase()).toContain("harness");
  });

  it("engine leg reflects the reported lifecycle state", async () => {
    const relay = newRelay();
    const host = await registerHarness(relay);
    const app = await helloed(relay);

    await host.connection.receive(
      req("harness.report", { engine: { state: "starting" } }),
    );
    let status = await systemStatus(app.connection, app.frames);
    expect(leg(status, "engine").state).toBe("connecting");

    await host.connection.receive(
      req("harness.report", {
        engine: { state: "failed", detail: "exit code 1" },
      }),
    );
    status = await systemStatus(app.connection, app.frames);
    expect(leg(status, "engine").state).toBe("down");
    expect(leg(status, "engine").reason).toContain("exit code 1");
  });

  it("harness disconnect takes harness + engine + model down", async () => {
    const relay = newRelay();
    const host = await registerHarness(relay);
    await host.connection.receive(
      req("harness.report", {
        engine: { state: "running" },
        status: { model: "m" },
      }),
    );
    const app = await helloed(relay);
    let status = await systemStatus(app.connection, app.frames);
    expect(leg(status, "engine").state).toBe("ok");

    host.connection.closed();
    status = await systemStatus(app.connection, app.frames);
    expect(leg(status, "harness").state).toBe("down");
    expect(leg(status, "engine").state).toBe("down");
    expect(leg(status, "model").state).toBe("down");
  });

  it("engine running without a reported model marks the model leg degraded", async () => {
    const relay = newRelay();
    const host = await registerHarness(relay);
    await host.connection.receive(
      req("harness.report", { engine: { state: "running" } }),
    );
    const app = await helloed(relay);
    const status = await systemStatus(app.connection, app.frames);
    expect(leg(status, "engine").state).toBe("ok");
    expect(leg(status, "model").state).toBe("degraded");
    expect(leg(status, "model").reason.toLowerCase()).toContain("model");
  });
});

describe("AC-2 (#33) version handshake names which side to update", () => {
  it("register with a lower protocol version fails and names the harness", async () => {
    const relay = newRelay({ protocolVersion: 2 });
    const { frames, connection } = connectPeer(relay);
    await connection.receive(
      req("session.hello", { protocolVersion: 2, token: TOKEN }),
    );
    frames.length = 0;
    await connection.receive(
      req("harness.register", { protocolVersion: 1, version: "0.1.0" }),
    );
    const error = errorOf(frames, `t${nextId - 1}`);
    expect(error.data?.code).toBe("protocol_version_mismatch");
    expect(error.data?.update).toBe("harness");
  });

  it("register with a higher protocol version names the relay", async () => {
    const relay = newRelay();
    const host = await helloed(relay);
    await host.connection.receive(
      req("harness.register", { protocolVersion: 9, version: "9.0.0" }),
    );
    const error = errorOf(host.frames, `t${nextId - 1}`);
    expect(error.data?.code).toBe("protocol_version_mismatch");
    expect(error.data?.update).toBe("relay");
  });

  it("a rejected handshake still lets status name the stale side", async () => {
    const relay = newRelay();
    const host = await helloed(relay);
    await host.connection.receive(
      req("harness.register", { protocolVersion: 9, version: "9.0.0" }),
    );

    const app = await helloed(relay);
    const status = await systemStatus(app.connection, app.frames);
    expect(leg(status, "harness").state).toBe("down");
    expect(status.mismatch?.update).toBe("relay");
    expect(status.mismatch?.detail).toContain("9");
  });

  it("a matching version registers and clears the mismatch", async () => {
    const relay = newRelay();
    const bad = await helloed(relay);
    await bad.connection.receive(
      req("harness.register", { protocolVersion: 9 }),
    );
    const good = await registerHarness(relay);
    expect(resultOf(good.frames, `t${nextId - 1}`).error).toBeUndefined();

    const app = await helloed(relay);
    const status = await systemStatus(app.connection, app.frames);
    expect(status.mismatch).toBeUndefined();
    expect(leg(status, "harness").state).toBe("ok");
    expect(status.versions.harness).toBe("0.1.0");
    expect(status.versions.harnessProtocol).toBe(1);
  });
});

describe("AC-3 (#33) diagnostics bundle redacts tokens and secrets", () => {
  it("logLines returns per-component tails with secrets redacted", async () => {
    const relay = newRelay();
    relay.log("accepted config api_key=sk-supersecret123456");
    relay.log(`install token ${TOKEN} loaded`);

    const host = await registerHarness(relay);
    await host.connection.receive(
      req("harness.report", {
        engine: { state: "running" },
        status: {
          model: "m",
          logTail: [
            "spawned engine with token=engine-secret-xyz",
            `auth header Bearer ${TOKEN}`,
            "plain line stays",
          ],
        },
      }),
    );

    const app = await helloed(relay);
    const status = await systemStatus(app.connection, app.frames, {
      logLines: 10,
    });
    const all = [
      ...(status.logs?.relay ?? []),
      ...(status.logs?.harness ?? []),
    ].join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain("sk-supersecret123456");
    expect(all).not.toContain("engine-secret-xyz");
    expect(all).toContain("plain line stays");
    expect(all).toContain("<redacted>");
  });

  it("omits logs entirely when logLines is 0", async () => {
    const relay = newRelay();
    const app = await helloed(relay);
    const status = await systemStatus(app.connection, app.frames);
    expect(status.logs).toBeUndefined();
  });
});

describe("AC-4 (#33) engine RSS + live sessions come from the harness report", () => {
  it("surfaces rssBytes and sessions reported by the harness", async () => {
    const relay = newRelay();
    const host = await registerHarness(relay);
    await host.connection.receive(
      req("harness.report", {
        engine: { state: "running" },
        status: {
          engineName: "engine-fake",
          engineVersion: "1.2.3",
          model: "fake-model-1",
          engineRssBytes: 84_934_656,
          sessions: 2,
        },
      }),
    );

    const app = await helloed(relay);
    const status = await systemStatus(app.connection, app.frames);
    expect(status.engine?.name).toBe("engine-fake");
    expect(status.engine?.version).toBe("1.2.3");
    expect(status.engine?.rssBytes).toBe(84_934_656);
    expect(status.engine?.sessions).toBe(2);
  });

  it("no engine block when nothing has been reported", async () => {
    const relay = newRelay();
    const app = await helloed(relay);
    const status = await systemStatus(app.connection, app.frames);
    expect(status.engine).toBeUndefined();
  });
});
