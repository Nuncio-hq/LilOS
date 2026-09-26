import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { Harness } from "../src/harness.js";
import { connectWs } from "../src/ws.js";

const SERVE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "engine-fake",
  "scripts",
  "serve.ts",
);
const bunAvailable =
  spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const wsAvailable =
  typeof (globalThis as { WebSocket?: unknown }).WebSocket === "function";

/**
 * WS transport smoke test: the full protocol over a real socket. The deeper
 * non-TS WebSocket proof lives in the Python client (AC-3).
 */
describe.runIf(bunAvailable && wsAvailable)("WebSocket transport", () => {
  test("AC-1 engine-fake speaks the protocol over ws://", async () => {
    const proc = spawn("bun", [SERVE, "--port", "0", "--tick", "2"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let buf = "";
        proc.stdout.on("data", (d) => {
          buf += d;
          const m = buf.match(/LISTENING (ws:\/\/[^\s]+)/);
          if (m) resolve(m[1]);
        });
        proc.on("exit", () => reject(new Error(`serve exited: ${buf}`)));
        setTimeout(
          () => reject(new Error("serve did not print LISTENING")),
          10_000,
        );
      });
      const conn = await connectWs(url);
      const h = new Harness(conn);
      try {
        const r = (await h.request("describe")) as {
          protocol: { name: string; version: number };
        };
        expect(r.protocol).toEqual({ name: "lilos-engine", version: 1 });
        const { sessionId } = (await h.request("session.start", {
          agent: "builder",
          cwd: "/t",
        })) as {
          sessionId: string;
        };
        const res = h.request("prompt", {
          sessionId,
          content: [{ type: "text", text: "Explain the relay package" }],
        }) as Promise<{ stopReason: string }>;
        await h.waitEvent(
          h.forSession(sessionId, (e) => e.type === "turn.completed"),
        );
        expect((await res).stopReason).toBe("end_turn");
      } finally {
        h.close();
      }
    } finally {
      proc.kill("SIGTERM");
    }
  }, 20_000);
});
