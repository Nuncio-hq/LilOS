/**
 * Issue #564: the client feed's WS upgrade authenticates. Until now any
 * local process — or any page open in the user's browser — could attach to
 * ws://127.0.0.1:4581/ws and read every session's live events (tool output,
 * file contents, diffs). The gate is the install token (the credential
 * /host and the relay hello already share) plus an app-Origin check for
 * handshakes a browser sends.
 *
 * Two layers here: `authorizeFeedUpgrade` as a function over Requests, and
 * a real node:http + `ws` upgrade wired the way index.ts wires it — the
 * refusals land as failed handshakes, not stubbed booleans.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { authorizeFeedUpgrade } from "../src/feed";
import { TOKEN, waitFor } from "./helpers";

const req = (query = "", headers: Record<string, string> = {}) =>
  new Request(`http://127.0.0.1:4581/ws${query}`, { headers });

describe("AC-1 authorizeFeedUpgrade refuses a socket without the credential or with a foreign Origin", () => {
  it.each<[string, string, Record<string, string>, number | undefined]>([
    ["missing token", "", {}, 401],
    ["empty token", "?token=", {}, 401],
    ["wrong token", "?token=nope", {}, 401],
    [
      "near-miss token (same length, last char different)",
      `?token=${TOKEN.slice(0, -1)}X`,
      {},
      401,
    ],
    ["prefix of the token (wrong length)", `?token=${TOKEN.slice(0, -1)}`, {}, 401],
    ["extended token (wrong length)", `?token=${TOKEN}x`, {}, 401],
    [
      "install token, no Origin (scripts/Bun clients)",
      `?token=${TOKEN}`,
      {},
      undefined,
    ],
    [
      "dev server origin",
      `?token=${TOKEN}`,
      { origin: "http://127.0.0.1:5200" },
      undefined,
    ],
    [
      "localhost on any port",
      `?token=${TOKEN}`,
      { origin: "http://localhost:9999" },
      undefined,
    ],
    [
      "https loopback",
      `?token=${TOKEN}`,
      { origin: "https://[::1]:8080" },
      undefined,
    ],
    [
      "Electron file:// window",
      `?token=${TOKEN}`,
      { origin: "file://" },
      undefined,
    ],
    [
      "opaque origin (sandboxed/file pages)",
      `?token=${TOKEN}`,
      { origin: "null" },
      undefined,
    ],
    [
      "a subdomain of localhost",
      `?token=${TOKEN}`,
      { origin: "http://app.localhost:5200" },
      undefined,
    ],
    [
      "foreign https origin",
      `?token=${TOKEN}`,
      { origin: "https://evil.example" },
      403,
    ],
    [
      "foreign http origin",
      `?token=${TOKEN}`,
      { origin: "http://evil.example" },
      403,
    ],
    [
      "loopback-lookalike host",
      `?token=${TOKEN}`,
      { origin: "http://127.0.0.1.evil.example" },
      403,
    ],
    [
      "non-http scheme",
      `?token=${TOKEN}`,
      { origin: "chrome-extension://abc" },
      403,
    ],
    [
      "foreign origin with NO token still refuses",
      "",
      { origin: "https://evil.example" },
      401,
    ],
    [
      "foreign origin with a WRONG token still refuses",
      "?token=nope",
      { origin: "https://evil.example" },
      401,
    ],
  ])("%s → %s", (_name, query, headers, status) => {
    const res = authorizeFeedUpgrade(req(query, headers), TOKEN);
    if (status === undefined) expect(res).toBeUndefined();
    else expect(res?.status).toBe(status);
  });

  it("an empty configured credential authenticates nothing — fails closed", () => {
    expect(authorizeFeedUpgrade(req("?token="), "")?.status).toBe(401);
    expect(authorizeFeedUpgrade(req(), "")?.status).toBe(401);
  });
});

/* A refused upgrade never reaches feed.attach, so no held or live frame can
   be delivered. The ws server below mirrors index.ts: gate first, upgrade
   only on pass; the attach path flushes a held frame so "allowed" is proven
   by real delivery, not just an open socket. */
const HELD_FRAME = JSON.stringify({ jsonrpc: "2.0", method: "event" });

interface GatedFeed {
  url: string;
  attachedCount: () => number;
  close: () => Promise<void>;
}

async function gatedFeed(token: string): Promise<GatedFeed> {
  const server: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const peers = new Set<WebSocket>();
  server.on("upgrade", (upReq, socket, head) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(upReq.headers)) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(name, v);
      } else if (value !== undefined) {
        headers.set(name, value);
      }
    }
    const denied = authorizeFeedUpgrade(
      new Request(`http://127.0.0.1${upReq.url}`, { headers }),
      token,
    );
    if (denied) {
      socket.write(
        `HTTP/1.1 ${denied.status} refused\r\nconnection: close\r\n\r\n`,
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(upReq, socket, head, (ws) => {
      peers.add(ws);
      ws.send(HELD_FRAME); // the attach-time held-frame flush
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    attachedCount: () => peers.size,
    close: () =>
      new Promise((resolve) => {
        for (const ws of peers) ws.terminate();
        server.close(() => resolve());
      }),
  };
}

const open = (url: string, origin?: string) =>
  new Promise<{ ws?: WebSocket; status?: number; frames: string[] }>(
    (resolve) => {
      const frames: string[] = [];
      const ws = new WebSocket(url, {
        ...(origin !== undefined ? { headers: { origin } } : {}),
      });
      ws.on("message", (m) => frames.push(String(m)));
      ws.on("open", () => resolve({ ws, frames }));
      ws.on("error", (e: Error) => {
        const status = /response: (\d{3})/.exec(e.message);
        resolve({ status: status ? Number(status[1]) : 0, frames });
      });
    },
  );

describe("AC-1 the real upgrade handshake refuses before any event is sent", () => {
  let feed: GatedFeed | undefined;
  afterEach(async () => {
    await feed?.close();
    feed = undefined;
  });

  it("a socket without the credential fails the handshake and receives nothing", async () => {
    feed = await gatedFeed(TOKEN);
    const r = await open(feed.url);
    expect(r.status).toBe(401);
    expect(r.ws).toBeUndefined();
    expect(r.frames).toEqual([]);
    expect(feed.attachedCount()).toBe(0);
  });

  it("a socket with a wrong credential fails the handshake", async () => {
    feed = await gatedFeed(TOKEN);
    const r = await open(`${feed.url}?token=nope`);
    expect(r.status).toBe(401);
    expect(r.frames).toEqual([]);
    expect(feed.attachedCount()).toBe(0);
  });

  it("a socket with a foreign Origin fails even with the credential", async () => {
    feed = await gatedFeed(TOKEN);
    const r = await open(`${feed.url}?token=${TOKEN}`, "https://evil.example");
    expect(r.status).toBe(403);
    expect(r.frames).toEqual([]);
    expect(feed.attachedCount()).toBe(0);
  });

  it("the install token opens the feed and the held frame is delivered", async () => {
    feed = await gatedFeed(TOKEN);
    const r = await open(`${feed.url}?token=${TOKEN}`);
    expect(r.ws).toBeTruthy();
    const frames = await waitFor(
      () => (r.frames.length ? r.frames : undefined),
      "held frame delivery",
    );
    expect(frames[0]).toBe(HELD_FRAME);
    expect(feed.attachedCount()).toBe(1);
    r.ws?.close();
  });

  it.each(["file://", "null", "http://localhost:5200", "http://127.0.0.1:1"])(
    "app origin %s opens with the install token",
    async (origin) => {
      feed = await gatedFeed(TOKEN);
      const r = await open(`${feed.url}?token=${TOKEN}`, origin);
      expect(r.ws).toBeTruthy();
      r.ws?.close();
    },
  );
});
