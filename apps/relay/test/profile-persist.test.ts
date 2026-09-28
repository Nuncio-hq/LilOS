import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RelayClient,
  type RelaySocket,
  type SocketFactory,
} from "@lilos/client-runtime";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

/**
 * Issue #118 AC-1 + AC-4: the profile lives in sqlite, so a migration-8
 * DB reports an empty profile on a fresh/existing install (the app prefills
 * from the OS) and values written once survive a relay restart. The
 * spawn/ws helpers mirror folders-persist.test.ts.
 */

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUN = process.env.LILOS_BUN_BIN ?? "bun";
const spawned: ChildProcess[] = [];
const homes: string[] = [];

afterAll(() => {
  for (const child of spawned) child.kill("SIGKILL");
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function wsFactory(): SocketFactory {
  const factory: SocketFactory = (url) => {
    const ws = new WebSocket(url);
    const listeners: Record<string, ((event: unknown) => void)[]> = {};
    ws.on("open", () => listeners.open?.forEach((f) => void f(undefined)));
    ws.on("message", (data: WebSocket.RawData) => {
      listeners.message?.forEach((f) => void f({ data: data.toString() }));
    });
    ws.on("close", (code: number, reason: Buffer) => {
      listeners.close?.forEach(
        (f) => void f({ code, reason: reason.toString() }),
      );
    });
    ws.on("error", (error: Error) => {
      listeners.error?.forEach((f) => void f(error));
    });
    const socket: RelaySocket = {
      get readyState() {
        return ws.readyState;
      },
      send: (data: string) => ws.send(data),
      close: (code?: number, reason?: string) => ws.close(code, reason),
      addEventListener(type: string, listener: (event: never) => void) {
        const list = listeners[type] ?? [];
        list.push(listener as (event: unknown) => void);
        listeners[type] = list;
      },
    };
    return socket;
  };
  return factory;
}

async function startRelay(home?: string) {
  const relayHome = home ?? mkdtempSync(join(tmpdir(), "lilos-relay-118-"));
  homes.push(relayHome);
  const child = spawn(BUN, ["run", "src/index.ts"], {
    cwd: RELAY_DIR,
    env: {
      ...process.env,
      LILOS_RELAY_HOME: relayHome,
      LILOS_RELAY_PORT: "0",
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
  const token = readFileSync(join(relayHome, "relay-token"), "utf8").trim();
  return {
    home: relayHome,
    token,
    url: `ws://${host}:${port}/ws`,
    proc: child,
  };
}

const connect = (url: string, token: string) =>
  new RelayClient({
    url,
    token,
    socketFactory: wsFactory(),
    autoReconnect: false,
    client: { name: "e2e-profile" },
  });

describe("AC-1/AC-4 profile settings persist in sqlite", () => {
  it("fresh DB reports empty profile; an update survives a relay restart", async () => {
    const first = await startRelay();
    const client = connect(first.url, first.token);
    await client.connect();

    // Migrated-but-untouched install: nothing stored, the app prefills.
    const before = await client.request<{ profile: Record<string, string> }>(
      "profile.get",
      {},
    );
    expect(before.profile).toEqual({});

    await client.request("profile.update", {
      userName: "Ada",
      companyName: "Ada Labs",
      avatarColor: "bg-rose-600",
    });
    client.close();
    first.proc.kill("SIGKILL");
    await new Promise<void>((r) => first.proc.once("exit", () => r()));

    const second = await startRelay(first.home);
    const back = connect(second.url, first.token);
    await back.connect();

    const { profile } = await back.request<{
      profile: Record<string, string>;
    }>("profile.get", {});
    expect(profile).toEqual({
      userName: "Ada",
      companyName: "Ada Labs",
      avatarColor: "bg-rose-600",
    });
    back.close();
  }, 30_000);
});
