import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { parseListeningPort, reserveLoopbackPort } from "../src/ready.js";

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
    ].join("\n");
    expect(parseListeningPort(text, "relay")).toBe(23456);
    expect(parseListeningPort(text, "harness")).toBe(23457);
    expect(parseListeningPort(text, "web")).toBe(23458);
    expect(parseListeningPort(text, "engine-fake")).toBe(23459);
  });

  it("keeps the latest line when a child reports twice", () => {
    const text = [
      "[relay] listening on http://127.0.0.1:20001 (ws: /ws)",
      "[relay] listening on http://127.0.0.1:20002 (ws: /ws)",
    ].join("\n");
    expect(parseListeningPort(text, "relay")).toBe(20002);
  });

  it("returns undefined until the line exists", () => {
    expect(
      parseListeningPort("[relay] instanceId: x", "relay"),
    ).toBeUndefined();
    expect(
      parseListeningPort(
        "[harness] surfaces listening on http://127.0.0.1:9",
        "harness",
      ),
    ).toBeUndefined();
    expect(
      parseListeningPort("listening on http://127.0.0.1:9", "web"),
    ).toBeUndefined();
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
});
