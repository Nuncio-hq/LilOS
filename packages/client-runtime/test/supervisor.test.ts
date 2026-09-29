import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelayError } from "../src/client";
import {
  ConnectionSupervisor,
  type SupervisedConnection,
} from "../src/supervisor";

/**
 * #154 AC-3/AC-4: the supervisor is the one reconnect owner — ladder
 * [3,4,8,16]s, reset after 30s healthy, offline parks until a network change,
 * foreground probes ≤3s keep-vs-replace, dead sockets skip the first rung.
 */

interface FakeLease extends SupervisedConnection {
  drop(): void;
  fail(error: unknown): void;
  closedCalls: number;
}

function makeLease(): FakeLease {
  let resolveClosed!: () => void;
  let rejectClosed!: (e: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  // Pre-mark handled: a lease can sit dropped before the monitor attaches.
  closed.catch(() => {});
  const lease: FakeLease = {
    closed,
    closedCalls: 0,
    close() {
      lease.closedCalls += 1;
      resolveClosed();
    },
    drop: () => resolveClosed(),
    fail: (e) => rejectClosed(e),
  };
  return lease;
}

interface Overrides {
  connect?: (signal: AbortSignal) => Promise<SupervisedConnection>;
  probe?: (connection: SupervisedConnection) => Promise<unknown>;
  isFatal?: (error: unknown) => boolean;
  onFatalError?: (error: unknown) => void;
}

function makeSupervisor(overrides: Overrides = {}) {
  const connects: number[] = [];
  const leases: FakeLease[] = [];
  const probeCalls: number[] = [];
  const supervisor = new ConnectionSupervisor({
    connect: async (signal) => {
      connects.push(Date.now());
      const lease = (await (overrides.connect?.(signal) ??
        makeLease())) as FakeLease;
      leases.push(lease);
      return lease;
    },
    probe: async (connection) => {
      probeCalls.push(Date.now());
      return await overrides.probe?.(connection);
    },
    isFatal: overrides.isFatal,
    onFatalError: overrides.onFatalError,
  });
  return { supervisor, connects, leases, probeCalls };
}

const tick = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe("ConnectionSupervisor (#154)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("AC-3 retries on the [3,4,8,16]s ladder and stays capped", async () => {
    const { supervisor, connects } = makeSupervisor({
      connect: async () => {
        throw new RelayError("connect refused", "connect_failed");
      },
    });
    supervisor.connect();
    await tick(77_000);
    const gaps = connects.slice(1).map((t, i) => t - (connects[i] ?? 0));
    expect(gaps).toEqual([3_000, 4_000, 8_000, 16_000, 16_000, 16_000]);
    expect(supervisor.state.get().phase).toBe("backoff");
    supervisor.dispose();
  });

  it("AC-3 resets the ladder after 30s of a healthy connection", async () => {
    let shouldFail = true;
    const { supervisor, connects, leases } = makeSupervisor({
      connect: async () => {
        if (shouldFail) throw new RelayError("refused", "connect_failed");
        return makeLease();
      },
    });
    supervisor.connect();
    await tick(10); // attempt 1 failed → 3s rung
    shouldFail = false;
    await tick(3_000);
    await tick(10);
    expect(supervisor.state.get().phase).toBe("connected");
    expect(connects).toHaveLength(2);

    // Healthy past the 30s reset horizon; a drop re-dials instantly and the
    // NEXT failure must restart at rung 1 (3s), not continue the ladder.
    await tick(31_000);
    leases.at(-1)?.drop();
    shouldFail = true;
    await tick(10);
    expect(connects).toHaveLength(3); // immediate re-attempt, failed
    expect(supervisor.state.get().phase).toBe("backoff");
    const thirdConnect = connects.at(-1) ?? 0;
    await tick(2_500);
    expect(connects).toHaveLength(3);
    await tick(600);
    expect(connects).toHaveLength(4);
    expect((connects.at(-1) ?? 0) - thirdConnect).toBe(3_000);
    supervisor.dispose();
  });

  it("AC-3 offline parks the loop until the network changes", async () => {
    const { supervisor, connects } = makeSupervisor();
    supervisor.setOnline(false);
    supervisor.connect();
    await tick(120_000);
    expect(supervisor.state.get().phase).toBe("offline");
    expect(connects).toHaveLength(0);

    supervisor.setOnline(true);
    await tick(10);
    expect(supervisor.state.get().phase).toBe("connected");
    expect(connects).toHaveLength(1);
    supervisor.dispose();
  });

  it("AC-4 foreground probe keeps a live socket, replaces a dead one immediately", async () => {
    const { supervisor, connects, probeCalls } = makeSupervisor();
    supervisor.connect();
    await tick(10);
    expect(supervisor.state.get().phase).toBe("connected");

    // Short background: probe answers → keep the same lease.
    supervisor.appForegrounded(45_000);
    await tick(10);
    expect(probeCalls).toHaveLength(1);
    expect(connects).toHaveLength(1);
    expect(supervisor.state.get().phase).toBe("connected");

    // This time the probe hangs: replaced right at the 3s probe timeout —
    // no first backoff rung.
    const dead = makeSupervisor({ probe: () => new Promise(() => {}) });
    dead.supervisor.connect();
    await tick(10);
    expect(dead.supervisor.state.get().phase).toBe("connected");
    dead.supervisor.appForegrounded(10_000);
    await tick(2_999);
    expect(dead.connects).toHaveLength(1); // still probing
    await tick(1);
    await tick(10);
    expect(dead.connects).toHaveLength(2);
    expect(dead.supervisor.state.get().phase).toBe("connected");
    supervisor.dispose();
    dead.supervisor.dispose();
  });

  it("AC-4 a rejecting probe also replaces immediately", async () => {
    const { supervisor, connects, probeCalls } = makeSupervisor({
      probe: async () => {
        throw new RelayError("ping timed out", "timeout");
      },
    });
    supervisor.connect();
    await tick(10);
    supervisor.appForegrounded(20_000);
    await tick(10);
    expect(probeCalls).toHaveLength(1);
    expect(connects).toHaveLength(2);
    expect(supervisor.state.get().phase).toBe("connected");
    supervisor.dispose();
  });

  it("AC-4 replaces the socket after >5min backgrounded without probing", async () => {
    const { supervisor, connects, probeCalls } = makeSupervisor();
    supervisor.connect();
    await tick(10);
    supervisor.appForegrounded(6 * 60_000);
    await tick(10);
    expect(probeCalls).toHaveLength(0);
    expect(connects).toHaveLength(2);
    expect(supervisor.state.get().phase).toBe("connected");
    supervisor.dispose();
  });

  it("AC-4 a socket that dies under the app reconnects without sleeping first", async () => {
    const { supervisor, leases, connects } = makeSupervisor();
    supervisor.connect();
    await tick(10);
    leases.at(-1)?.drop();
    await tick(10);
    // Clean drop → immediate re-attempt (interrupted path), not a 3s sleep.
    expect(connects).toHaveLength(2);
    expect(supervisor.state.get().phase).toBe("connected");
    supervisor.dispose();
  });

  it("AC-4 foreground during backoff wakes the sleep into an immediate attempt", async () => {
    const firstOnly = { calls: 0 };
    const { supervisor, connects } = makeSupervisor({
      connect: async () => {
        firstOnly.calls += 1;
        if (firstOnly.calls === 1)
          throw new RelayError("refused", "connect_failed");
        return makeLease();
      },
    });
    supervisor.connect();
    await tick(10);
    expect(supervisor.state.get().phase).toBe("backoff");
    supervisor.appForegrounded(30_000);
    await tick(10);
    expect(connects).toHaveLength(2);
    expect(supervisor.state.get().phase).toBe("connected");
    supervisor.dispose();
  });

  it("AC-3 disconnect stops retries and closes the held lease", async () => {
    const { supervisor, leases, connects } = makeSupervisor();
    supervisor.connect();
    await tick(10);
    supervisor.disconnect();
    await tick(10);
    expect(supervisor.state.get().phase).toBe("idle");
    expect(leases[0]?.closedCalls).toBeGreaterThan(0);
    await tick(60_000);
    expect(connects).toHaveLength(1);
    supervisor.dispose();
  });

  it("a 4403 device-revoked drop is fatal: blocked once, no reconnect loop", async () => {
    const fatals: unknown[] = [];
    const { supervisor, leases, connects } = makeSupervisor({
      onFatalError: (e) => fatals.push(e),
    });
    supervisor.connect();
    await tick(10);
    expect(supervisor.state.get().phase).toBe("connected");

    // The Mac revoked this phone mid-session — same shape the app sees when
    // the relay closes the socket 4403.
    leases.at(-1)?.fail(new RelayError("device revoked", "device_revoked"));
    await tick(10);
    expect(supervisor.state.get().phase).toBe("blocked");
    expect(fatals).toHaveLength(1);
    expect((fatals[0] as RelayError).code).toBe("device_revoked");

    // No retry storm: the loop stays parked — the app tears down instead.
    await tick(120_000);
    expect(connects).toHaveLength(1);
    supervisor.dispose();
  });

  it("AC-5 a fatal handshake failure parks the loop in blocked", async () => {
    const fatals: unknown[] = [];
    const { supervisor, connects } = makeSupervisor({
      connect: async () => {
        throw new RelayError("bad device credential", "unauthenticated");
      },
      onFatalError: (e) => fatals.push(e),
    });
    supervisor.connect();
    await tick(10);
    expect(supervisor.state.get().phase).toBe("blocked");
    expect(fatals).toHaveLength(1);
    await tick(120_000);
    expect(connects).toHaveLength(1); // no retry storm
    // ...but a manual retry escapes it.
    supervisor.retryNow();
    await tick(10);
    expect(connects).toHaveLength(2);
    supervisor.dispose();
  });
});
