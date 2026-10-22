import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  CONNECT_BOOT_RECONCILE_MS,
  reconcileBeforeEngine,
} from "../src/connect-boot";
import { createMemoryLogger } from "../src/log";
import { createPluginRestart, PLUGIN_RESTART_LOG } from "../src/plugin-restart";
import { openDmConversation, setupWorld, waitFor } from "./helpers";

describe("D-#817 boot reconcile before the engine", () => {
  it("does not start the engine until the boot reconcile resolves", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const pending = reconcileBeforeEngine(
      () => gate,
      () => {
        started = true;
      },
      { timeoutMs: CONNECT_BOOT_RECONCILE_MS },
    );
    await Promise.resolve();
    expect(started).toBe(false);
    release();
    await pending;
    expect(started).toBe(true);
  });

  it("starts the engine when the boot reconcile exceeds CONNECT_BOOT_RECONCILE_MS", async () => {
    vi.useFakeTimers();
    try {
      const log = createMemoryLogger();
      let started = false;
      const pending = reconcileBeforeEngine(
        () => new Promise(() => {}),
        () => {
          started = true;
        },
        { timeoutMs: CONNECT_BOOT_RECONCILE_MS, log },
      );
      await vi.advanceTimersByTimeAsync(CONNECT_BOOT_RECONCILE_MS - 1);
      expect(started).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(started).toBe(true);
      expect(log.lines.join("\n")).toContain(
        "connect boot reconcile timed out; starting the engine",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("the harness entry awaits the boot reconcile before supervisor.start", () => {
    const src = readFileSync(
      new URL("../src/index.ts", import.meta.url),
      "utf8",
    );
    const boot = src.indexOf("reconcileBeforeEngine");
    const start = src.indexOf("supervisor.start");
    expect(boot).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(boot);
    expect(src).toContain("CONNECT_BOOT_RECONCILE_MS");
  });
});

describe("D-#817 restart the engine when a running copy lands", () => {
  it("restarts once the engine is idle after a plugin copy", async () => {
    vi.useFakeTimers();
    try {
      let idle = false;
      const restarts: string[] = [];
      const log = createMemoryLogger();
      const gate = createPluginRestart({
        engineStarted: () => true,
        idle: () => idle,
        restart: () => {
          restarts.push("go");
        },
        log,
        pollMs: 1_000,
      });
      gate.noteCopied();
      gate.noteCopied();
      expect(restarts).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(restarts).toEqual([]);
      idle = true;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(restarts).toEqual(["go"]);
      expect(log.lines.join("\n")).toContain(PLUGIN_RESTART_LOG);
      gate.noteCopied();
      expect(restarts).toEqual(["go", "go"]);
      gate.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a copy before the engine starts does not schedule a restart", () => {
    let started = false;
    const restarts: number[] = [];
    const gate = createPluginRestart({
      engineStarted: () => started,
      idle: () => true,
      restart: () => {
        restarts.push(1);
      },
      log: createMemoryLogger(),
    });
    gate.noteCopied();
    started = true;
    expect(restarts).toEqual([]);
    gate.stop();
  });
});

describe("D-#817 refresh the plugin before the first session.start", () => {
  it("awaits reconcile after ensureAgent and before session.start", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const w = await setupWorld({
      harnessExtra: {
        connect: {
          reconcile: async () => {
            order.push("reconcile");
            await gate;
            order.push("reconcile-done");
          },
          employeeRemoved: () => {},
          report: () => [],
        },
      },
    });
    try {
      const { channel } = await openDmConversation(w.user);
      void w.user.request("conversations.open", {
        channelId: channel.id,
        text: "hello",
      });
      await waitFor(
        () => (order.includes("reconcile") ? true : undefined),
        "reconcile",
      );
      expect(
        w.engineCalls.some(
          (call) =>
            call.method === "agents.list" || call.method === "agents.create",
        ),
      ).toBe(true);
      expect(
        w.engineCalls.some((call) => call.method === "session.start"),
      ).toBe(false);
      release();
      await waitFor(
        () => (order.includes("reconcile-done") ? true : undefined),
        "reconcile done",
      );
      await waitFor(
        () =>
          w.engineCalls.some((call) => call.method === "session.start")
            ? true
            : undefined,
        "session.start",
      );
      expect(order.indexOf("reconcile")).toBeLessThan(
        order.indexOf("reconcile-done"),
      );
    } finally {
      release();
      await w.cleanup();
    }
  });
});
