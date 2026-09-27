import type { SystemStatusResult } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { RelayClient, RelayError } from "../src/client";
import type { RelaySocket } from "../src/socket";
import { formatDiagnostics, toStatusComponents } from "../src/status";

type StoredListener = (event: unknown) => void;

class FakeSocket implements RelaySocket {
  readyState = 0;
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, StoredListener[]>();

  addEventListener(type: string, listener: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener as StoredListener);
    this.listeners.set(type, list);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }

  openSocket(): void {
    this.readyState = 1;
    this.fire("open");
  }
  emit(frame: unknown): void {
    this.fire("message", { data: JSON.stringify(frame) } as never);
  }
  private fire(type: string, event?: never): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  respondTo(method: string, result: unknown): void {
    const request = this.sent
      .map((raw) => JSON.parse(raw) as { id?: string; method?: string })
      .reverse()
      .find((f) => f.method === method && f.id !== undefined);
    if (!request) throw new Error(`no ${method} request was sent`);
    this.emit({ jsonrpc: "2.0", id: request.id, result });
  }
}

const WELCOME = { protocolVersion: 1, relayVersion: "0.0.0", instanceId: "i" };

function makeClient() {
  const socket = new FakeSocket();
  const client = new RelayClient({
    url: "ws://fake",
    token: "tok",
    socketFactory: () => socket,
    requestTimeoutMs: 200,
    connectTimeoutMs: 200,
    autoReconnect: false,
  });
  return { socket, client };
}

async function connectClient(client: RelayClient, socket: FakeSocket) {
  const pending = client.connect();
  await Promise.resolve();
  socket.openSocket();
  await Promise.resolve();
  socket.respondTo("session.hello", WELCOME);
  await pending;
  socket.respondTo("employees.list", { employees: [] });
  socket.respondTo("channels.list", { channels: [] });
  socket.respondTo("conversations.list", { conversations: [] });
}

const RESULT: SystemStatusResult = {
  protocolVersion: 1,
  generatedAt: 1_759_000_000_000,
  components: [
    { id: "relay", label: "Relay", state: "ok", reason: "answering" },
    {
      id: "harness",
      label: "Harness",
      state: "ok",
      reason: "connected v0.1.0",
    },
    { id: "engine", label: "Engine", state: "ok", reason: "running fake" },
    { id: "model", label: "Model", state: "ok", reason: "running fake-1" },
  ],
  versions: {
    relay: "0.1.0",
    harness: "0.1.0",
    relayProtocol: 1,
    harnessProtocol: 1,
  },
  engine: {
    name: "engine-fake",
    version: "1.2.3",
    rssBytes: 84_934_656,
    sessions: 2,
  },
  logs: { relay: ["r1"], harness: ["h1"] },
};

describe("AC-1 (#33) client maps wire status to UI rows", () => {
  it("passes through relay-provided rows", () => {
    const rows = toStatusComponents({ result: RESULT, connection: "ready" });
    expect(rows.map((r) => r.id)).toEqual([
      "relay",
      "harness",
      "engine",
      "model",
    ]);
    expect(rows.every((r) => r.state === "ok")).toBe(true);
  });

  it("shows relay connecting while the socket is not ready", () => {
    const rows = toStatusComponents({ connection: "connecting" });
    expect(rows[0].state).toBe("connecting");
    // #53: downstream legs wait on the relay — blocked, not down.
    expect(rows.slice(1).every((r) => r.state === "blocked")).toBe(true);
    expect(rows[1].reason.toLowerCase()).toContain("relay");
  });

  it("a fatal version mismatch marks relay down and names the update", () => {
    const rows = toStatusComponents({
      connection: "closed",
      fatal: new RelayError(
        "protocol version mismatch",
        "protocol_version_mismatch",
        {
          update: "client",
          clientVersion: 1,
          serverVersion: 2,
        },
      ),
    });
    expect(rows[0].id).toBe("relay");
    expect(rows[0].state).toBe("down");
    expect(rows[0].reason.toLowerCase()).toContain("update the app");
  });
});

describe("AC-1 (#53) raw reasons map to a plain reason + next step", () => {
  const BROKEN: SystemStatusResult = {
    ...RESULT,
    components: [
      { id: "relay", label: "Relay", state: "ok", reason: "answering" },
      {
        id: "harness",
        label: "Harness",
        state: "ok",
        reason: "connected v0.1.0",
      },
      {
        id: "engine",
        label: "Engine",
        state: "down",
        reason:
          "engine broken-engine failed to start x5: Error: spawn /nonexistent/lilos-engine ENOENT",
      },
      {
        id: "model",
        label: "Model",
        state: "blocked",
        reason: "waiting for the engine",
      },
    ],
  };

  it("shows a plain reason + hint and keeps the raw text in detail", () => {
    const rows = toStatusComponents({ result: BROKEN, connection: "ready" });
    const engine = rows.find((r) => r.id === "engine");
    expect(engine?.state).toBe("down");
    expect(engine?.reason).not.toContain("ENOENT");
    expect(engine?.reason).not.toContain("spawn");
    expect(engine?.reason.toLowerCase()).toContain("wasn't found");
    expect(engine?.hint?.toLowerCase()).toContain("settings");
    // The raw error is preserved for the collapsed details line.
    expect(engine?.detail).toContain("ENOENT");
  });

  it("an unknown raw error still gets a plain reason + generic next step", () => {
    const weird: SystemStatusResult = {
      ...BROKEN,
      components: [
        BROKEN.components[0],
        BROKEN.components[1],
        {
          id: "engine",
          label: "Engine",
          state: "down",
          reason: "engine x blew up: Error: frobnicate(stack) at line 9",
        },
        BROKEN.components[3],
      ],
    };
    const engine = toStatusComponents({
      result: weird,
      connection: "ready",
    }).find((r) => r.id === "engine");
    expect(engine?.reason).not.toContain("Error:");
    expect(engine?.hint?.length).toBeGreaterThan(0);
    expect(engine?.detail).toContain("frobnicate");
  });

  it("Copy diagnostics keeps the raw reason", () => {
    const text = formatDiagnostics({ result: BROKEN, connection: "ready" });
    expect(text).toContain("ENOENT");
    expect(text).toContain("failed to start");
  });

  it("ok rows pass through untouched", () => {
    const rows = toStatusComponents({ result: RESULT, connection: "ready" });
    expect(rows.every((r) => r.state === "ok")).toBe(true);
    expect(rows.find((r) => r.id === "engine")?.detail).toBeUndefined();
    expect(rows.find((r) => r.id === "engine")?.hint).toBeUndefined();
  });
});

describe("AC-2 (#53) legs waiting on a down upstream leg are blocked", () => {
  it("relay unreachable marks harness/engine/model blocked — one issue", () => {
    const rows = toStatusComponents({ connection: "closed" });
    expect(rows[0].state).toBe("down");
    expect(rows.slice(1).every((r) => r.state === "blocked")).toBe(true);
    expect(rows[1].reason.toLowerCase()).toContain("waiting");
  });

  it("a wire blocked row passes through with plain wording", () => {
    const rows = toStatusComponents({
      result: {
        ...RESULT,
        components: [
          RESULT.components[0],
          RESULT.components[1],
          {
            id: "engine",
            label: "Engine",
            state: "down",
            reason: "engine exited (code 1)",
          },
          {
            id: "model",
            label: "Model",
            state: "blocked",
            reason: "waiting for the engine",
          },
        ],
      },
      connection: "ready",
    });
    const model = rows.find((r) => r.id === "model");
    expect(model?.state).toBe("blocked");
    expect(model?.reason.toLowerCase()).toContain("waiting");
    expect(model?.hint).toBeUndefined();
    expect(model?.detail).toBeUndefined();
  });
});

describe("AC-3 (#33) diagnostics bundle formatting", () => {
  it("includes versions, states, engine numbers, and log tails", () => {
    const text = formatDiagnostics({
      result: RESULT,
      connection: "ready",
      app: { name: "prototype", version: "0.0.0" },
    });
    expect(text).toContain("relay: 0.1.0");
    expect(text).toContain("harness: 0.1.0");
    expect(text).toContain("engine-fake");
    expect(text).toContain("81.0 MB");
    expect(text).toContain("sessions: 2");
    expect(text).toContain("r1");
    expect(text).toContain("h1");
    expect(text).toContain("ok");
  });

  it("still produces a bundle when the relay is unreachable", () => {
    const text = formatDiagnostics({ connection: "closed" });
    expect(text.toLowerCase()).toContain("closed");
    expect(text).toContain("relay");
  });
});

describe("AC-1/4 (#33) systemStatus roundtrip + polling atom", () => {
  it("requests system.status and parses the result", async () => {
    const { socket, client } = makeClient();
    await connectClient(client, socket);
    const pending = client.systemStatus({ logLines: 5 });
    socket.respondTo("system.status", RESULT);
    const status = await pending;
    expect(status.components).toHaveLength(4);
    expect(status.engine?.rssBytes).toBe(84_934_656);
    client.close();
  });

  it("refreshSystemStatus populates the status atom", async () => {
    const { socket, client } = makeClient();
    await connectClient(client, socket);
    const pending = client.refreshSystemStatus();
    socket.respondTo("system.status", RESULT);
    await pending;
    expect(client.status.get().result?.components).toHaveLength(4);
    expect(client.status.get().connection).toBe("ready");
    client.close();
  });
});

describe("AC-2 (#85) a missing Hermes reads plainly", () => {
  const NO_HERMES: SystemStatusResult = {
    ...RESULT,
    components: [
      RESULT.components[0],
      RESULT.components[1],
      {
        id: "engine",
        label: "Engine",
        state: "down",
        reason:
          "engine hermes failed to start x5: Hermes not found at /gone/hermes (HERMES_BIN is set to it)",
      },
      RESULT.components[3],
    ],
  };

  it("the plain reason names the path Hermes was expected at", () => {
    const engine = toStatusComponents({
      result: NO_HERMES,
      connection: "ready",
    }).find((r) => r.id === "engine");
    expect(engine?.state).toBe("down");
    expect(engine?.reason).toBe(
      "Hermes not found at /gone/hermes (HERMES_BIN is set to it).",
    );
    expect(engine?.hint).toMatch(/hermes-bin|HERMES_BIN/i);
    // The supervisor wrapper stays available under the collapsed detail.
    expect(engine?.detail).toContain("failed to start x5");
  });

  it("a discovery sweep that found nothing still reads plainly", () => {
    const result: SystemStatusResult = {
      ...NO_HERMES,
      components: [
        NO_HERMES.components[0],
        NO_HERMES.components[1],
        {
          id: "engine",
          label: "Engine",
          state: "down",
          reason:
            "engine hermes failed to start x5: Hermes not found — looked in ~/.local/bin/hermes, /opt/homebrew/bin/hermes, /usr/bin/hermes",
        },
        NO_HERMES.components[3],
      ],
    };
    const engine = toStatusComponents({ result, connection: "ready" }).find(
      (r) => r.id === "engine",
    );
    expect(engine?.reason).toMatch(/^Hermes not found/);
    expect(engine?.reason).toContain("looked in");
    expect(engine?.hint?.length).toBeGreaterThan(0);
  });
});
