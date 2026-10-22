import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claimLoopbackPort,
  parseListeningPort,
  reserveLoopbackPort,
} from "../dev/ready";

const lockFile = (port: number) =>
  join(tmpdir(), "lilos-port-locks", String(port));

describe("parseListeningPort (#825)", () => {
  it("reads the port each child actually bound", () => {
    const text = [
      "[relay] instanceId: 11111111-2222-4333-8444-555555555555",
      "[relay] listening on http://127.0.0.1:23456 (ws: /ws)",
      "[harness] surfaces listening on http://127.0.0.1:41000",
      "[harness] instanceId: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "[harness] listening on http://127.0.0.1:23457",
      "[web] listening on http://127.0.0.1:23458",
      "LISTENING ws://127.0.0.1:23459/ws",
      "",
    ].join("\n");
    expect(parseListeningPort(text, "relay")).toBe(23456);
    expect(parseListeningPort(text, "harness")).toBe(23457);
    expect(parseListeningPort(text, "web")).toBe(23458);
    expect(parseListeningPort(text, "engine-fake")).toBe(23459);
  });

  it("keeps the latest complete line when a child reports twice", () => {
    const text = [
      "[relay] listening on http://127.0.0.1:20001 (ws: /ws)",
      "[relay] listening on http://127.0.0.1:20002 (ws: /ws)",
      "",
    ].join("\n");
    expect(parseListeningPort(text, "relay")).toBe(20002);
  });

  it("returns undefined until a terminated line exists", () => {
    expect(
      parseListeningPort("[relay] instanceId: x\n", "relay"),
    ).toBeUndefined();
    expect(
      parseListeningPort(
        "[harness] surfaces listening on http://127.0.0.1:9\n",
        "harness",
      ),
    ).toBeUndefined();
    expect(
      parseListeningPort("listening on http://127.0.0.1:9\n", "web"),
    ).toBeUndefined();
    expect(
      parseListeningPort(
        "[relay] listening on http://127.0.0.1:23456 (ws: /ws)",
        "relay",
      ),
    ).toBeUndefined();
  });

  it("does not take a port from a chunk split mid-number", () => {
    const head = "[relay] listening on http://127.0.0.1:23";
    expect(parseListeningPort(head, "relay")).toBeUndefined();
    expect(parseListeningPort(`${head}456 (ws: /ws)\n`, "relay")).toBe(23456);
    /* A later partial must not replace a line that already ended. */
    expect(
      parseListeningPort(
        "[relay] listening on http://127.0.0.1:20001 (ws: /ws)\n[relay] listening on http://127.0.0.1:23",
        "relay",
      ),
    ).toBe(20001);
  });
});

const bind = (port: number) =>
  new Promise<{ close: () => Promise<void> }>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });

const plant = (port: number, body: string) => {
  mkdirSync(join(tmpdir(), "lilos-port-locks"), { recursive: true });
  writeFileSync(lockFile(port), body);
};

describe("reserveLoopbackPort (#825)", () => {
  it("hands out distinct below-floor ports that are free to bind", async () => {
    const held = await Promise.all(
      Array.from({ length: 8 }, () => reserveLoopbackPort()),
    );
    try {
      const ports = held.map((h) => h.port);
      expect(new Set(ports).size).toBe(ports.length);
      for (const port of ports) {
        expect(port).toBeGreaterThanOrEqual(20_000);
        expect(port).toBeLessThanOrEqual(32_767);
        expect(readFileSync(lockFile(port), "utf8")).toBe(`${process.pid}\n`);
      }
      const sockets = await Promise.all(ports.map((port) => bind(port)));
      await Promise.all(sockets.map((s) => s.close()));
    } finally {
      for (const h of held) h.release();
    }
  });

  it("release is idempotent and frees the claim", async () => {
    const held = await reserveLoopbackPort();
    held.release();
    held.release();
    const again = await reserveLoopbackPort();
    again.release();
    expect(again.port).toBeGreaterThan(0);
  });

  it("does not unlink an empty or non-numeric lock", async () => {
    /* An empty file used to parse as pid 0. pidAlive(0) is false, so a
       sweep deleted a lock whose owner had not finished writing it. */
    const seed = await reserveLoopbackPort();
    const emptyPort = seed.port;
    seed.release();
    plant(emptyPort, "");
    const other = await reserveLoopbackPort();
    other.release();
    expect(readFileSync(lockFile(emptyPort), "utf8")).toBe("");
    expect(await claimLoopbackPort(emptyPort)).toBeUndefined();
    expect(readFileSync(lockFile(emptyPort), "utf8")).toBe("");

    const seed2 = await reserveLoopbackPort();
    const textPort = seed2.port;
    seed2.release();
    plant(textPort, "nope\n");
    expect(await claimLoopbackPort(textPort)).toBeUndefined();
    expect(readFileSync(lockFile(textPort), "utf8")).toBe("nope\n");
    unlinkSync(lockFile(emptyPort));
    unlinkSync(lockFile(textPort));
  });

  it("a live lock stays, and two claims of one dead lock yield one winner", async () => {
    const live = await reserveLoopbackPort();
    try {
      expect(await claimLoopbackPort(live.port)).toBeUndefined();
      expect(readFileSync(lockFile(live.port), "utf8")).toBe(
        `${process.pid}\n`,
      );
    } finally {
      live.release();
    }

    const seed = await reserveLoopbackPort();
    const port = seed.port;
    seed.release();
    /* Above pid_max, so it cannot be a live process and cannot be reused. */
    plant(port, "2147483647\n");
    const [a, b] = await Promise.all([
      claimLoopbackPort(port),
      claimLoopbackPort(port),
    ]);
    const winners = [a, b].filter((held) => held !== undefined);
    try {
      expect(winners).toHaveLength(1);
      expect(readFileSync(lockFile(port), "utf8").trim()).toBe(
        String(process.pid),
      );
      const socket = await bind(port);
      await socket.close();
    } finally {
      for (const held of winners) held.release();
    }
  });
});
