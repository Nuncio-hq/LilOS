import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelaySocket, SocketFactory } from "@lilos/client-runtime";
import { RelayClient } from "@lilos/client-runtime";
import { connectFake, FakeEngine } from "@lilos/engine-fake";
import type { CheckpointStore } from "@lilos/host";
import { afterEach } from "vitest";
import { createPairingService } from "../../relay/src/pairing";
import { createRelay } from "../../relay/src/session";
import { createMemoryStore } from "../../relay/test/memory-store";
import type { EngineConnection } from "../src/engine/client";
import { Harness, type HarnessOptions } from "../src/harness";
import { createMemoryLogger } from "../src/log";
import { createFakeSleepGuard } from "../src/sleep";

/**
 * Shared unit-test setup (#437): the in-process relay+harness world each
 * spec used to carry its own copy of. Files keep a thin local `setupWorld`
 * wrapper only where their call sites take a different argument shape;
 * test bodies stay unchanged.
 */

export const TOKEN = "test-token";
export type Relay = ReturnType<typeof createRelay>;

export const homes: string[] = [];
afterEach(() => {
  for (const d of homes.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

/** A tmpdir "home" (realpath'd — macOS /var → /private/var alias). */
export const mkhome = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lilos-home-")));
  homes.push(dir);
  return dir;
};

/** A RelaySocket that talks straight into a relay.connect() peer. */
export const socketFor =
  (relay: Relay): SocketFactory =>
  () => {
    const listeners = new Map<string, Array<(e?: unknown) => void>>();
    const emit = (type: string, e?: unknown) =>
      queueMicrotask(() =>
        (listeners.get(type) ?? []).forEach((fn) => void fn(e)),
      );
    let peer: { receive(f: string): Promise<void>; closed(): void };
    let readyState = 0;
    const socket = {
      get readyState() {
        return readyState;
      },
      send: (frame: string) => {
        void peer.receive(frame);
      },
      close: () => {
        readyState = 3;
        peer.closed();
        emit("close", { code: 1000, reason: "closed" });
      },
      addEventListener(type: string, fn: (e?: unknown) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
    } as unknown as RelaySocket;
    peer = relay.connect({
      send: (frame) => emit("message", { data: frame }),
      close: (code, reason) => emit("close", { code, reason }),
    });
    queueMicrotask(() => {
      readyState = 1;
      emit("open");
    });
    return socket;
  };

export const waitFor = async <T>(
  fn: () => T | undefined | Promise<T | undefined>,
  what: string,
  timeoutMs = 10_000,
): Promise<T> => {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
};

export interface World {
  relay: Relay;
  store: ReturnType<typeof createMemoryStore>;
  pairing?: ReturnType<typeof createPairingService>;
  engine?: FakeEngine;
  engineConn?: EngineConnection;
  engineCalls: { method: string; params: unknown }[];
  /** Every socket the harness's RelayClient has opened — close() drops it. */
  relaySockets: RelaySocket[];
  harnessRelay: RelayClient;
  harness: Harness;
  sleep: ReturnType<typeof createFakeSleepGuard>;
  log: ReturnType<typeof createMemoryLogger>;
  user: RelayClient;
  /** A paired-device client — present when `phone: true` was passed. */
  phone?: RelayClient;
  workdir: string;
  checkpoints?: CheckpointStore;
  cleanup: () => Promise<void>;
}

export interface WorldOptions {
  /** engine-fake turn tick (default 1). */
  tick?: number;
  /** A pre-built engine; `null` runs the world engineless. */
  engine?: FakeEngine | null;
  /** Extra FakeEngine opts merged into `{tick}` when creating one. */
  engineOpts?: ConstructorParameters<typeof FakeEngine>[0];
  /** Default true — set false to leave the engine unattached. */
  attachEngine?: boolean;
  /** Transform the engine connection before it is attached. */
  wrap?: (conn: EngineConnection, engine: FakeEngine) => EngineConnection;
  hideCaps?: string[];
  checkpoints?: CheckpointStore;
  /** Harness default cwd (default "/tmp/lilos-test"). */
  workdir?: string;
  /** cleanup() removes the workdir (for mkdtemp'd dirs). */
  rmWorkdir?: boolean;
  /** Relay + harness home-folder boundary (the folders.browse world). */
  homeDir?: string;
  /** Add the pairing service to the relay. */
  pairing?: boolean;
  /** Connect a paired-device client as `phone` (implies `pairing`). */
  phone?: boolean;
  /** Record the harness RelayClient's sockets into `relaySockets`. */
  captureSockets?: boolean;
  /** Passed to the harness RelayClient; absent = the client's own default. */
  reconnectMinDelayMs?: number;
  /** Extra Harness options spread last (e.g. the #346 reaper knobs). */
  harnessExtra?: Partial<HarnessOptions>;
}

/** One in-memory relay + harness (+ fake engine) world. */
export async function setupWorld(opts: WorldOptions = {}): Promise<World> {
  const workdir = opts.workdir ?? "/tmp/lilos-test";
  const store = createMemoryStore();
  const pairing = opts.pairing ? createPairingService({ store }) : undefined;
  const relay = createRelay({
    store,
    token: TOKEN,
    ...(pairing ? { pairing } : {}),
    ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
  });
  const engine =
    opts.engine === null
      ? undefined
      : (opts.engine ??
        new FakeEngine({ tick: opts.tick ?? 1, ...opts.engineOpts }));
  const engineCalls: { method: string; params: unknown }[] = [];
  let engineConn: EngineConnection | undefined;
  if (engine) {
    const raw = connectFake(engine) as unknown as EngineConnection;
    const origRequest = raw.request.bind(raw);
    raw.request = <T = unknown>(
      method: string,
      params?: unknown,
    ): Promise<T> => {
      engineCalls.push({ method, params });
      return origRequest<T>(method, params);
    };
    engineConn = opts.wrap ? opts.wrap(raw, engine) : raw;
  }
  const relaySockets: RelaySocket[] = [];
  const capturingFactory =
    (inner: SocketFactory): SocketFactory =>
    (url: string) => {
      const s = inner(url);
      relaySockets.push(s);
      return s;
    };
  const factory = socketFor(relay);
  const sleep = createFakeSleepGuard();
  const log = createMemoryLogger();
  const harnessRelay = new RelayClient({
    url: "mem://harness",
    token: TOKEN,
    socketFactory: opts.captureSockets ? capturingFactory(factory) : factory,
    ...(opts.reconnectMinDelayMs === undefined
      ? {}
      : { reconnectMinDelayMs: opts.reconnectMinDelayMs }),
  });
  const harness = new Harness({
    relay: harnessRelay,
    sleep,
    workdir,
    log,
    ...(opts.hideCaps ? { hideCaps: opts.hideCaps } : {}),
    ...(opts.checkpoints ? { checkpoints: opts.checkpoints } : {}),
    ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
    ...opts.harnessExtra,
  });
  if (engineConn && opts.attachEngine !== false) {
    harness.attachEngine(engineConn);
  }
  await harness.start();
  const user = new RelayClient({
    url: "mem://user",
    token: TOKEN,
    socketFactory: socketFor(relay),
  });
  await user.connect();
  let phone: RelayClient | undefined;
  if (opts.phone) {
    if (!pairing) throw new Error("phone world needs pairing: true");
    const grant = await pairing.mintGrant();
    const ex = await pairing.exchangeGrant({ code: grant.code });
    if (!("device" in ex)) throw new Error("exchange failed");
    phone = new RelayClient({
      url: "mem://phone",
      device: { deviceId: ex.device.id, credential: ex.credential },
      socketFactory: socketFor(relay),
    });
    await phone.connect();
  }
  return {
    relay,
    store,
    pairing,
    engine,
    engineConn,
    engineCalls,
    relaySockets,
    harnessRelay,
    harness,
    sleep,
    log,
    user,
    phone,
    workdir,
    checkpoints: opts.checkpoints,
    cleanup: async () => {
      user.close();
      phone?.close();
      await harness.stop();
      if (opts.rmWorkdir) rmSync(workdir, { recursive: true, force: true });
    },
  };
}

/** Open a DM channel as the user; returns the channel. */
export async function openDm(user: RelayClient) {
  const { employee } = await user.request<{ employee: { id: string } }>(
    "employees.create",
    { name: "Ada", role: "engineer", profile: "builder" },
  );
  const { channel } = await user.request<{
    channel: { id: string; employeeId: string };
  }>("channels.openDm", { employeeId: employee.id });
  return channel;
}

/** Open a DM as the user; returns employee + channel ids. */
export async function openDmConversation(user: RelayClient) {
  const { employee } = await user.request<{ employee: { id: string } }>(
    "employees.create",
    { name: "Ada", role: "engineer", profile: "builder" },
  );
  const { channel } = await user.request<{
    channel: { id: string; employeeId: string };
  }>("channels.openDm", { employeeId: employee.id });
  return { employee, channel };
}
