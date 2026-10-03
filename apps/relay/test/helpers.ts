import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RelaySocket, SocketFactory } from "@lilos/client-runtime";
import { APP_PROTOCOL_VERSION, type AppErrorCode } from "@lilos/contracts/app";
import { afterAll, afterEach } from "vitest";
import WebSocket from "ws";
import { createPairingService } from "../src/pairing";
import {
  createRelay,
  type RelayOptions,
  type RelayWsPeer,
} from "../src/session";
import { createMemoryStore } from "./memory-store";

/**
 * Shared unit-test setup (#437): the in-process peer rig every relay spec
 * used to carry its own copy of (connectPeer + req/resultOf + helloed), the
 * device-scope world (pairing + helloedToken/helloedDevice/registeredHost),
 * and the spawned-relay rig (startRelay + wsFactory) the persistence and e2e
 * specs share. Test bodies stay unchanged; file-specific wrappers remain in
 * the specs that need a different shape.
 */

export const TOKEN = "test-token";
export type Relay = ReturnType<typeof createRelay>;

export function connectPeer(relay: Relay) {
  const frames: unknown[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  const closedCodes: number[] = [];
  const peer: RelayWsPeer = {
    send: (frame) => frames.push(JSON.parse(frame)),
    close: (code, reason) => {
      closed.push({ code, reason });
      closedCodes.push(code ?? 1000);
    },
  };
  return { frames, closed, closedCodes, connection: relay.connect(peer), peer };
}

export let nextId = 0;
export const req = (method: string, params: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id: `t${nextId++}`, method, params });
export const lastId = () => `t${nextId - 1}`;

export const resultOf = (frames: unknown[], id: string) => {
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
export const errorOf = (frames: unknown[], id: string) => {
  const { error } = resultOf(frames, id);
  if (!error) throw new Error(`expected an error frame for ${id}`);
  return error;
};
export const errorData = (frames: unknown[], id: string) =>
  errorOf(frames, id).data?.code as AppErrorCode;

/** Request/response frames (they carry an id). */
export const calls = (frames: unknown[]) =>
  (frames as { id?: string }[]).filter((f) => f.id !== undefined);
/** Notification/event frames (they carry a method). */
export const events = (frames: unknown[]) =>
  (frames as { method?: string; params?: unknown }[]).filter(
    (f) => f.method !== undefined,
  );
export const eventsNamed = (frames: unknown[], method: string) =>
  events(frames).filter((f) => f.method === method);
/** Forwarded host calls arrive as request frames with `hr-N` ids (events
    like `devices.changed` also carry a method but no id). */
export const requestsTo = (frames: unknown[]) =>
  (frames as { method?: string; id?: string; params?: unknown }[]).filter(
    (f) => f.id?.startsWith("hr-") === true,
  );

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

export const newRelay = (opts: Partial<RelayOptions> = {}) =>
  createRelay({ store: createMemoryStore(), token: TOKEN, ...opts });

/** Store + pairing + relay — the device-scope world. */
export const newWorld = (homeDir?: string) => {
  const store = createMemoryStore();
  const pairing = createPairingService({ store });
  const relay = createRelay({ store, token: TOKEN, pairing, homeDir });
  return { store, pairing, relay };
};

/** A peer that passed `session.hello` with the install token. */
export async function helloedToken(relay: Relay) {
  const p = connectPeer(relay);
  await p.connection.receive(
    req("session.hello", {
      protocolVersion: APP_PROTOCOL_VERSION,
      token: TOKEN,
    }),
  );
  const welcome = resultOf(p.frames, lastId()).result as {
    engineHost: {
      connected: boolean;
      capabilities?: { id: string }[];
      models?: { id: string }[];
      defaultModel?: string;
      defaultProvider?: string;
    };
  };
  p.frames.length = 0;
  return { ...p, welcome };
}
export const helloed = helloedToken;

/** A peer that paired + helloed as a device (phone scope). */
export async function helloedDevice(
  pairing: ReturnType<typeof createPairingService>,
  relay: Relay,
) {
  const grant = await pairing.mintGrant();
  const ex = await pairing.exchangeGrant({ code: grant.code });
  if (!("device" in ex)) throw new Error("exchange failed");
  const p = connectPeer(relay);
  await p.connection.receive(
    req("session.hello", {
      protocolVersion: APP_PROTOCOL_VERSION,
      deviceId: ex.device.id,
      credential: ex.credential,
    }),
  );
  p.frames.length = 0;
  return { ...p, device: ex.device };
}

/** A helloed peer that registers as the engine host. */
export async function registeredHost(relay: Relay) {
  const p = await helloedToken(relay);
  await p.connection.receive(
    req("harness.register", { protocolVersion: 1, version: "0.0.0-test" }),
  );
  p.frames.length = 0;
  return p;
}

/** An employee + DM channel over an already-helloed connection. */
export async function setupChannel(
  frames: unknown[],
  connection: { receive(d: string): Promise<void> },
) {
  await connection.receive(
    req("employees.create", { name: "Ada", role: "eng" }),
  );
  const employee = (
    resultOf(frames, lastId()).result as {
      employee: { id: string; name: string };
    }
  ).employee;
  await connection.receive(req("channels.openDm", { employeeId: employee.id }));
  const channel = (
    resultOf(frames, lastId()).result as {
      channel: { id: string; kind: string; employeeId: string };
    }
  ).channel;
  return { employee, channel };
}

/* A DM channel + open conversation, bound to an engine session id. */
export async function dmWithConversation(
  connection: { receive(d: string): Promise<void> },
  frames: unknown[],
) {
  await connection.receive(
    req("employees.create", { name: "Ada", role: "eng" }),
  );
  const { employee } = resultOf(frames, lastId()).result as {
    employee: { id: string };
  };
  await connection.receive(req("channels.openDm", { employeeId: employee.id }));
  const { channel } = resultOf(frames, lastId()).result as {
    channel: { id: string };
  };
  await connection.receive(
    req("conversations.open", {
      channelId: channel.id,
      text: "Summarize the repo",
    }),
  );
  const { conversation } = resultOf(frames, lastId()).result as {
    conversation: { id: string; channelId: string; model?: string };
  };
  return { employee, channel, conversation };
}

/* ------------------------------------------------------------------ */
/* Spawned-relay rig: a real `bun run src/index.ts` over a tmpdir home. */
/* ------------------------------------------------------------------ */

export const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BUN = process.env.LILOS_BUN_BIN ?? "bun";
export const spawned: ChildProcess[] = [];
export const homes: string[] = [];

afterAll(() => {
  for (const child of spawned) child.kill("SIGKILL");
});
afterEach(() => {
  for (const d of homes.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A tmpdir "home" (realpath'd — macOS /var → /private/var alias). */
export const mkhome = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lilos-home-")));
  homes.push(dir);
  return dir;
};

/** ws-package → RelaySocket adapter (Node has no usable DOM WebSocket). */
export function wsFactory(): {
  factory: SocketFactory;
  last: () => WebSocket | undefined;
} {
  let last: WebSocket | undefined;
  const factory: SocketFactory = (url) => {
    const ws = new WebSocket(url);
    last = ws;
    const listeners: Record<string, ((event: unknown) => void)[]> = {};
    ws.on("open", () => {
      listeners.open?.forEach((f) => {
        f(undefined);
      });
    });
    ws.on("message", (data: WebSocket.RawData) => {
      listeners.message?.forEach((f) => {
        f({ data: data.toString() });
      });
    });
    ws.on("close", (code: number, reason: Buffer) => {
      listeners.close?.forEach((f) => {
        f({ code, reason: reason.toString() });
      });
    });
    ws.on("error", (error: Error) => {
      listeners.error?.forEach((f) => {
        f(error);
      });
    });
    const listenersFor = (type: string) => (listeners[type] ??= []);
    const socket: RelaySocket = {
      get readyState() {
        return ws.readyState;
      },
      send: (data: string) => ws.send(data),
      close: (code?: number, reason?: string) => ws.close(code, reason),
      addEventListener(type: string, listener: (event: never) => void) {
        listenersFor(type).push(listener as (event: unknown) => void);
      },
    };
    return socket;
  };
  return { factory, last: () => last };
}

export async function startRelay(
  arg: string | Record<string, string> = {},
): Promise<{
  home: string;
  host: string;
  port: number;
  token: string;
  url: string;
  proc: ChildProcess;
}> {
  const env = typeof arg === "string" ? { LILOS_RELAY_HOME: arg } : arg;
  const home =
    env.LILOS_RELAY_HOME ?? mkdtempSync(join(tmpdir(), "lilos-relay-test-"));
  homes.push(home);
  const child = spawn(BUN, ["run", "src/index.ts"], {
    cwd: RELAY_DIR,
    env: {
      ...process.env,
      LILOS_RELAY_HOME: home,
      LILOS_RELAY_PORT: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(child);
  const address = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("relay did not start")),
      15_000,
    );
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(
        /listening on http:\/\/([0-9a-fA-F.:]+):(\d+)/,
      );
      if (match) {
        clearTimeout(timer);
        resolve(`${match[1]}:${match[2]}`);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`relay exited ${code}: ${buffer}`));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
    });
  });
  const [host, port] = address.split(":");
  const token = readFileSync(join(home, "relay-token"), "utf8").trim();
  return {
    home,
    host,
    port: Number(port),
    token,
    url: `ws://${host}:${port}/ws`,
    proc: child,
  };
}
