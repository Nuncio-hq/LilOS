import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import {
  PORT_SLICE,
  parseListeningPort,
  requireSlicePort,
  type SliceUse,
  slicePort,
  workerIndex,
} from "../dev/ready";

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

const USES = Object.keys(PORT_SLICE.offsets) as SliceUse[];

describe("PORT_SLICE (#825)", () => {
  it("gives each worker index a block, and each use its own port in it", () => {
    const indexes = [0, 1, 2, 3, 4, 5, 6, 7, PORT_SLICE.maxIndex];
    const seen = new Set<number>();
    for (const index of indexes) {
      const ports = USES.map((use) => slicePort(use, index));
      expect(new Set(ports).size).toBe(USES.length);
      for (const use of USES) {
        const port = slicePort(use, index);
        expect(port).toBe(
          PORT_SLICE.base + index * PORT_SLICE.stride + PORT_SLICE.offsets[use],
        );
        expect(port).toBeGreaterThanOrEqual(PORT_SLICE.base);
        expect(port).toBeLessThan(PORT_SLICE.floor);
        expect(seen.has(port)).toBe(false);
        seen.add(port);
      }
    }
    const atZero = new Set(USES.map((use) => slicePort(use, 0)));
    for (const use of USES) {
      expect(atZero.has(slicePort(use, 1))).toBe(false);
    }
    expect(slicePort("web4", PORT_SLICE.maxIndex)).toBeLessThan(
      PORT_SLICE.floor,
    );
    expect(() => slicePort("relay", PORT_SLICE.maxIndex + 1)).toThrow(
      /does not fit/,
    );
  });

  it("reads the runner index and treats a bare shell as no index", () => {
    expect(workerIndex({})).toBeUndefined();
    expect(workerIndex({ TEST_PARALLEL_INDEX: "0", VITEST_POOL_ID: "4" })).toBe(
      0,
    );
    expect(workerIndex({ VITEST_POOL_ID: "3" })).toBe(3);
  });

  it("adds LILOS_TEST_INDEX to the runner index as an offset", () => {
    expect(
      workerIndex({ TEST_PARALLEL_INDEX: "1", LILOS_TEST_INDEX: "20" }),
    ).toBe(21);
    expect(workerIndex({ LILOS_TEST_INDEX: "20" })).toBeUndefined();
    expect(() =>
      workerIndex({ TEST_PARALLEL_INDEX: "0", LILOS_TEST_INDEX: "-1" }),
    ).toThrow(/offset/);
  });

  it("falls back to the probe band when no runner index is set", async () => {
    const port = await requireSlicePort("web", {});
    expect(port).toBeGreaterThanOrEqual(PORT_SLICE.probeLo);
    expect(port).toBeLessThanOrEqual(PORT_SLICE.probeHi);
    expect(port).toBeLessThan(PORT_SLICE.base);
    const socket = await bind(port);
    await socket.close();
  });

  it("fails loudly when the slice port is already held", async () => {
    const index = 20;
    const port = slicePort("web", index);
    const socket = await bind(port);
    try {
      await expect(
        requireSlicePort("web", { TEST_PARALLEL_INDEX: String(index) }),
      ).rejects.toThrow(
        new RegExp(
          `port ${port} \\(web, offset ${PORT_SLICE.offsets.web}, worker ${index}\\) is already held by pid ${process.pid}`,
        ),
      );
    } finally {
      await socket.close();
    }
  });
});
