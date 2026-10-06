import http from "node:http";
import { expect, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #564 — the harness feed upgrade authenticates. Before this change
 * any local process, or any page open in the user's browser, could attach
 * to ws://127.0.0.1:4581/ws and read every session's live engine events
 * (tool output, file contents, diffs, command output). The /ws upgrade now
 * requires the install token (`?token=` — a browser WebSocket can't set
 * headers) and refuses a foreign browser Origin — both checks run before
 * the socket is upgraded, so a refused client never attaches and never
 * sees a held or live frame.
 */

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac564", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

/** Hand-rolled WS upgrade probe on node:http — the Origin header is ours. */
function feedUpgrade(opts: {
  query?: string;
  origin?: string;
}): Promise<number | "upgraded"> {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port: stack.ports.feed,
      path: `/ws${opts.query ?? ""}`,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "MDEyMzQ1Njc4OWFiY2RlZg==",
        "sec-websocket-version": "13",
        ...(opts.origin ? { origin: opts.origin } : {}),
      },
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve("upgraded");
    });
    req.on("error", () => resolve(0));
    req.end();
  });
}

test("AC-1 a feed socket without the credential, or with a foreign Origin, is refused before any event is sent", async ({
  page,
}) => {
  const token = encodeURIComponent(stack.relayToken);

  // Missing / wrong credential — refused pre-upgrade.
  expect(await feedUpgrade({})).toBe(401);
  expect(await feedUpgrade({ query: "?token=nope" })).toBe(401);

  // A foreign browser Origin is refused even WITH the credential.
  expect(
    await feedUpgrade({
      query: `?token=${token}`,
      origin: "https://evil.example",
    }),
  ).toBe(403);

  // The app's own origins pass: the packaged file:// window, the dev page's.
  expect(
    await feedUpgrade({ query: `?token=${token}`, origin: "file://" }),
  ).toBe("upgraded");
  expect(
    await feedUpgrade({ query: `?token=${token}`, origin: stack.webUrl }),
  ).toBe("upgraded");

  /* A real browser page on the app origin: no token → the socket errors at
     the handshake — nothing is ever delivered to it. */
  await page.goto(`${stack.webUrl}/`);
  const refused = await page.evaluate(
    (url) =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(url);
        ws.onerror = () => resolve(true);
        ws.onopen = () => resolve(false);
      }),
    stack.feedWs,
  );
  expect(refused).toBe(true);

  /* The same page + the install token — exactly what EngineClient sends —
     opens the feed and `describe` answers. */
  const described = await page.evaluate(
    (url) =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(url);
        ws.onerror = () => resolve(false);
        ws.onopen = () =>
          ws.send(
            JSON.stringify({ jsonrpc: "2.0", id: 1, method: "describe" }),
          );
        ws.onmessage = (e) => {
          const f = JSON.parse(String(e.data)) as {
            id?: number;
            result?: { name?: string };
          };
          if (f.id === 1) resolve(Boolean(f.result?.name));
        };
        setTimeout(() => resolve(false), 10_000);
      }),
    `${stack.feedWs}?token=${token}`,
  );
  expect(described).toBe(true);
});

test("AC-1 /healthz stays open for readiness probes (the #273 identity nonce)", async () => {
  const res = await fetch(`http://127.0.0.1:${stack.ports.feed}/healthz`);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    ok: true,
    instanceId: expect.any(String),
  });
});
