import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withEngineProtocolToken } from "@lilos/contracts/auth";
import { ENGINE_PROTOCOL_TOKEN_ENV } from "@lilos/contracts/env";
import { describe, expect, test } from "vitest";
import { connectWs } from "../src/ws.js";

/**
 * #752: engine-fake's protocol socket (the same Bun.serve shape as the
 * other adapter) binds 127.0.0.1 only and refuses a `/ws` upgrade that
 * does not present the per-launch token. A connect on a non-loopback
 * address is refused, and `/proc/net/tcp` shows the listener is not on
 * every interface.
 */

const SERVE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "engine-fake",
  "scripts",
  "serve.ts",
);
const TOKEN = "protocol-token-for-test";

const bunAvailable =
  spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const wsAvailable =
  typeof (globalThis as { WebSocket?: unknown }).WebSocket === "function";

interface Adapter {
  url: string;
  port: number;
  proc: ChildProcess;
  stop: () => void;
}

function nonLoopbackIPv4(): string {
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  throw new Error("no non-loopback IPv4 — cannot prove the bind");
}

/** TCP result: "connected", "timeout", or an errno such as ECONNREFUSED. */
function tcpProbe(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: 1_000 });
    const done = (result: string) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done("connected"));
    socket.once("timeout", () => done("timeout"));
    socket.once("error", (err: NodeJS.ErrnoException) =>
      done(err.code ?? err.message),
    );
  });
}

/** LISTEN rows in /proc/net/tcp{,6} whose local port is `port` (Linux). */
function listeningHex(port: number): { v4: string[]; v6: string[] } {
  const parse = (file: string): string[] => {
    const text = readFileSync(file, "utf8");
    const out: string[] = [];
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      const local = cols[1];
      const state = cols[3];
      if (!local || state !== "0A") continue;
      const sep = local.lastIndexOf(":");
      if (Number.parseInt(local.slice(sep + 1), 16) !== port) continue;
      out.push(local.slice(0, sep).toUpperCase());
    }
    return out;
  };
  return {
    v4: parse("/proc/net/tcp"),
    v6: parse("/proc/net/tcp6"),
  };
}

async function startAdapter(): Promise<Adapter> {
  const proc = spawn("bun", [SERVE, "--port", "0", "--tick", "5"], {
    env: { ...process.env, [ENGINE_PROTOCOL_TOKEN_ENV]: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(
      () => reject(new Error(`serve did not print LISTENING:\n${buf}`)),
      10_000,
    );
    proc.stdout?.on("data", (d) => {
      buf += String(d);
      const m = buf.match(/LISTENING (ws:\/\/\S+)/);
      if (m?.[1]) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.on("exit", (code) =>
      reject(new Error(`serve exited ${code} before LISTENING:\n${buf}`)),
    );
  });
  return {
    url,
    port: Number(new URL(url).port),
    proc,
    stop: () => proc.kill("SIGTERM"),
  };
}

describe.runIf(bunAvailable && wsAvailable)(
  "#752 engine adapter socket",
  () => {
    test("a connection without the token is refused; one with the token works", async () => {
      const adapter = await startAdapter();
      try {
        const missing = await fetch(adapter.url.replace(/^ws:/, "http:"));
        expect(missing.status).toBe(401);
        const wrong = await fetch(
          `${adapter.url.replace(/^ws:/, "http:")}?token=nope`,
        );
        expect(wrong.status).toBe(401);
        await expect(connectWs(adapter.url, 2_000)).rejects.toThrow();
        const conn = await connectWs(
          withEngineProtocolToken(adapter.url, TOKEN),
        );
        try {
          const described = (await conn.request("describe")) as {
            protocol: { name: string; version: number };
          };
          expect(described.protocol).toEqual({
            name: "lilos-engine",
            version: 1,
          });
        } finally {
          conn.close();
        }
      } finally {
        adapter.stop();
      }
    }, 20_000);

    test("the listener is not reachable on a non-loopback address", async () => {
      const adapter = await startAdapter();
      try {
        const host = nonLoopbackIPv4();
        // Refused or silently dropped both mean unreachable: a firewall or a
        // VPN interface drops instead of refusing. The bind itself is proven
        // by the /proc check below (Linux, i.e. CI).
        expect(await tcpProbe(host, adapter.port)).not.toBe("connected");
        expect(await tcpProbe("127.0.0.1", adapter.port)).toBe("connected");
        if (process.platform === "linux") {
          const bound = listeningHex(adapter.port);
          // 0100007F is 127.0.0.1 in /proc's little-endian hex. 00000000 is
          // every interface — the bug this test was written to catch.
          expect(bound.v4).toEqual(["0100007F"]);
          expect(bound.v6).toEqual([]);
        }
      } finally {
        adapter.stop();
      }
    }, 20_000);
  },
);
