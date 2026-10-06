import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { HermesBackendSupervisor } from "../src/backend.js";
import type { GatewayLike } from "../src/gateway.js";
import { HermesHostConflict, type HermesServeHandle } from "../src/serve.js";

/**
 * #548 — when a relaunch discovers another Hermes backend now owns the
 * host, the verdict is `failed` on the first failure: the crash budget is
 * for crashes, and no retry here changes who owns the host. The budget is
 * still spent so `kick()` re-arms once the owner is gone.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fakeGw = (): GatewayLike => ({
  serverRequests: [],
  request: () => Promise.resolve({}),
  respond: () => {},
  onEvent: () => () => {},
  onRequest: () => () => {},
  onCancel: () => () => {},
  onClose: () => () => {},
  close: () => {},
});

const fakeHandle = (child: EventEmitter): HermesServeHandle => ({
  port: 1,
  token: "t",
  url: "http://127.0.0.1:1",
  child: child as unknown as HermesServeHandle["child"],
  logTail: () => "",
  close: () => Promise.resolve(),
});

/** A supervisor whose spawn steps are scripted — no real hermes/gateway. */
class Scripted extends HermesBackendSupervisor {
  plan: Array<"up" | "conflict"> = ["up"];
  readonly spawns: string[] = [];
  lastChild?: EventEmitter;

  protected override async spawnOnce() {
    const step = this.plan[Math.min(this.spawns.length, this.plan.length - 1)];
    this.spawns.push(step ?? "up");
    if (step === "conflict") {
      throw new HermesHostConflict(
        "another Hermes backend is already running on this Mac (PID 96194, port 55066)",
        { pid: 96194, port: 55066 },
      );
    }
    this.lastChild = new EventEmitter();
    return { gw: fakeGw(), handle: fakeHandle(this.lastChild) };
  }
}

const OPTS = {
  bin: "fake-hermes",
  minBackoffMs: 1,
  maxBackoffMs: 2,
  stableAfterMs: 60_000,
  maxAttempts: 5,
};

type Call = [kind: string, detail: string | undefined];

function reactor(calls: Call[]) {
  return {
    setGateway: () => {},
    markBackendDown: (d: string, s?: "restarting" | "failed") =>
      calls.push(["down", `${d}|${s}`]),
    markBackendFailed: (d: string) => calls.push(["failed", d]),
  };
}

describe("AC-3 (#548) the backend supervisor fails the conflict fast, not after 5 retries", () => {
  it("the first spawn's conflict propagates once — no supervisor retry", async () => {
    const sup = new Scripted(OPTS);
    sup.plan = ["conflict"];
    const err = await sup.start().catch((e) => e);
    expect(err).toBeInstanceOf(HermesHostConflict);
    expect(sup.spawns).toEqual(["conflict"]);
  });

  it("a relaunch that hits the attach fails once and spends the budget", async () => {
    const calls: Call[] = [];
    const sup = new Scripted(OPTS);
    sup.plan = ["up", "conflict"];
    await sup.start();
    sup.attachReactor(reactor(calls));
    // The live backend dies; the relaunch discovers the host is taken.
    sup.lastChild?.emit("exit", 0, null);
    await sleep(50);
    expect(sup.spawns).toEqual(["up", "conflict"]);
    const failed = calls.filter(([k]) => k === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.[1]).toContain("already running");
    await sleep(50);
    expect(sup.spawns).toHaveLength(2); // no retry loop queued
    await sup.close();
  });

  it("kick() re-arms after the conflict verdict once the owner could be gone", async () => {
    const calls: Call[] = [];
    const sup = new Scripted(OPTS);
    sup.plan = ["up", "conflict", "up"];
    await sup.start();
    sup.attachReactor(reactor(calls));
    sup.lastChild?.emit("exit", 0, null);
    await sleep(50);
    expect(calls.filter(([k]) => k === "failed")).toHaveLength(1);
    // A caller touches the engine → kick → relaunch binds cleanly now.
    sup.kick();
    await sleep(50);
    expect(sup.spawns).toEqual(["up", "conflict", "up"]);
    await sup.close();
  });
});
