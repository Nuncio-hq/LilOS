import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  openDefaultAgent,
  pickPorts,
  type Stack,
  startChat,
} from "./helpers/stack";

/**
 * Issue #772 — a thread that repeats itself or stalls shows Stuck.
 *   AC-1 six identical tool calls → Stuck, with the reason
 *   AC-2 a different step clears it
 *   AC-3 Stop on the card stops the turn
 *   AC-4 a push when Settings → Phone → Stuck is on, none when it is off
 *
 * The push lands on the relay's Expo sender. LILOS_EXPO_ENDPOINT points
 * that at a collector this file owns — the same seam the relay uses for
 * a fake sink (`apps/relay/src/index.ts`).
 */

test.describe.configure({ timeout: 180_000 });

const REASON = "Same web search 6 times";
const SHOTS = path.join("test-results", "ac772");
mkdirSync(SHOTS, { recursive: true });

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
}

function lanAddress(): string | undefined {
  const physical: string[] = [];
  const other: string[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal)
        (name.startsWith("en") ? physical : other).push(a.address);
    }
  }
  return physical[0] ?? other[0];
}

interface PushMsg {
  title?: string;
  body?: string;
}

function collectPushes(): Promise<{
  url: string;
  got: PushMsg[];
  close: () => Promise<void>;
}> {
  const got: PushMsg[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let messages: PushMsg[] = [];
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
        if (Array.isArray(parsed)) messages = parsed as PushMsg[];
      } catch {
        messages = [];
      }
      got.push(...messages);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: messages.map(() => ({ status: "ok" })) }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/push`,
        got,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function rpc(
  wsUrl: string,
  hello: Record<string, unknown>,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(wsUrl);
    const send = (id: number, m: string, p: Record<string, unknown>) =>
      sock.send(JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p }));
    sock.onerror = () => reject(new Error(`ws error ${wsUrl}`));
    sock.onclose = (ev) => {
      if (ev.code !== 1000)
        reject(new Error(`ws closed ${ev.code} ${ev.reason} ${wsUrl}`));
    };
    sock.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        error?: { message?: string };
        result?: Record<string, unknown>;
      };
      if (msg.error) {
        sock.close();
        reject(new Error(msg.error.message ?? "rpc error"));
        return;
      }
      if (msg.id === 1) send(2, method, params);
      else if (msg.id === 2) {
        sock.close();
        resolve(msg.result ?? {});
      }
    };
    sock.onopen = () => send(1, "session.hello", hello);
  });
}

/** A paired phone with push registered, so a stuck mark has somewhere to go. */
async function registerPhone(stack: Stack, lan: string) {
  const offered = await rpc(
    `${stack.relayWs}?token=${encodeURIComponent(stack.relayToken)}`,
    {
      protocolVersion: 1,
      token: stack.relayToken,
      client: { name: "e2e" },
    },
    "pairing.offer",
    {},
  );
  const offer = offered.offer as { code: string };
  const port = new URL(stack.relayWs).port;
  const exchanged = await fetch(`http://${lan}:${port}/pair/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: offer.code.replaceAll("-", ""),
      name: "E2E iPhone",
    }),
  }).then((r) => r.json() as Promise<{ deviceId: string; credential: string }>);
  const deviceQuery = new URLSearchParams({
    deviceId: exchanged.deviceId,
    credential: exchanged.credential,
  });
  await rpc(
    `${stack.relayWs}?${deviceQuery}`,
    {
      protocolVersion: 1,
      deviceId: exchanged.deviceId,
      credential: exchanged.credential,
      client: { name: "e2e-phone" },
    },
    "push.register",
    {
      token: "ExponentPushToken[e2e-772]",
      prefs: {
        needsApproval: true,
        waitingForInput: true,
        completed: true,
        failed: true,
      },
    },
  );
}

let stack: Stack;
let sink: { got: PushMsg[]; close: () => Promise<void> };
let lan: string;

test.beforeAll(async () => {
  lan = lanAddress() ?? "";
  if (!lan) return;
  sink = await collectPushes();
  stack = await bootStack("772", await pickPorts(), {
    LILOS_RELAY_TAILSCALE_IP: lan,
    LILOS_RELAY_TAILSCALE_NAME: "mac.tailnet.test",
    LILOS_EXPO_ENDPOINT: sink.url,
  });
  await registerPhone(stack, lan);
});

test.afterAll(async () => {
  await stack?.stop();
  await sink?.close();
});

async function agentOf(page: Page) {
  return openDefaultAgent(page, stack.webUrl);
}

const card = (page: Page) => page.locator("[data-stuck]");

test("six identical searches show Stuck with the reason, above a working thread", async ({
  page,
}) => {
  test.skip(!lan, "no LAN address for the phone-pairing stand-in");
  const agent = await agentOf(page);
  await startChat(page, stack.webUrl, agent, "LILOS_TURN_HOLD");
  await startChat(page, stack.webUrl, agent, "stuck:");
  await expect(card(page)).toContainText(REASON, { timeout: 20_000 });
  await shot(page, "1-repeat-shows-stuck.png");
  await expect(
    card(page).getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  await expect(
    card(page).getByRole("button", { name: "Message", exact: true }),
  ).toBeVisible();
  await card(page)
    .getByRole("button", { name: "Message", exact: true })
    .click();
  await expect(page.locator("[data-thread-panel] textarea")).toBeFocused();
  await expect(page.locator("main")).toContainText("1 stuck");
  const texts = await page
    .locator("main")
    .locator("[role=button]")
    .allTextContents();
  const stuckAt = texts.findIndex((t) => t.includes("Same web search"));
  const holdAt = texts.findIndex((t) => t.includes("LILOS_TURN_HOLD"));
  expect(stuckAt).toBeGreaterThanOrEqual(0);
  expect(holdAt).toBeGreaterThan(stuckAt);
});

test("a different step clears Stuck", async ({ page }) => {
  test.skip(!lan, "no LAN address for the phone-pairing stand-in");
  const agent = await agentOf(page);
  await startChat(page, stack.webUrl, agent, "stuck: clear");
  await expect(card(page)).toContainText(REASON, { timeout: 20_000 });
  await shot(page, "2-before-clear.png");
  await expect(card(page)).toBeHidden({ timeout: 20_000 });
  await shot(page, "2-cleared.png");
});

test("Stop on the card stops the turn", async ({ page }) => {
  test.skip(!lan, "no LAN address for the phone-pairing stand-in");
  const agent = await agentOf(page);
  await startChat(page, stack.webUrl, agent, "stuck:");
  await expect(card(page)).toContainText(REASON, { timeout: 20_000 });
  await card(page).getByRole("button", { name: "Stop", exact: true }).click();
  await expect(card(page)).toBeHidden({ timeout: 15_000 });
  await shot(page, "3-stopped.png");
  await expect(
    page
      .locator("[data-thread-panel]")
      .getByRole("button", { name: "Stop (⌘.)" }),
  ).toHaveCount(0);
});

test("a push when Stuck is on, and none when it is off", async ({ page }) => {
  test.skip(!lan, "no LAN address for the phone-pairing stand-in");
  const agent = await agentOf(page);
  const before = sink.got.length;
  await startChat(page, stack.webUrl, agent, "stuck:");
  await expect(card(page)).toContainText(REASON, { timeout: 20_000 });
  await page.waitForTimeout(500);
  expect(sink.got.slice(before)).toEqual([]);

  await page.goto(`${stack.webUrl}/#?page=settings&view=phone`);
  const sw = page.getByRole("switch", { name: "Stuck notifications" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await shot(page, "4-phone-stuck-on.png");

  await startChat(page, stack.webUrl, agent, "stuck:");
  await expect(card(page)).toContainText(REASON, { timeout: 20_000 });
  await expect
    .poll(() => sink.got.some((m) => m.body?.includes(REASON)), {
      timeout: 10_000,
    })
    .toBe(true);
});
