import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  pickPorts,
  relayRpc,
  type Stack,
  skipFirstRun,
  v3Peek,
} from "./helpers/stack";

/**
 * Evidence for #899 — after a restart, Devin's engine sits idle
 * (`available: true`, never started) yet every Devin surface still gets
 * the real catalog: "Loading models…" while the ask is in flight, then
 * "SWE-2 High" / effort "Max" — never "Engine default". One screenshot
 * per surface (new chat, open thread, agent page) for loading and
 * loaded, plus the refused-ask chip. Paused product (`LILOS_COMPANY: "0"`).
 *
 *   LILOS_EVIDENCE=1 LILOS_EVIDENCE_OUT=/tmp/e899 \
 *     bunx playwright test e2e/evidence-899.spec.ts
 */
test.skip(
  process.env.LILOS_EVIDENCE !== "1",
  "evidence capture only — set LILOS_EVIDENCE=1",
);

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT =
  process.env.LILOS_EVIDENCE_OUT ??
  path.join(here, "..", "test-results", "evidence", "899");
const RT = "acp:devin";

const DEVIN = {
  models: [
    {
      id: "swe-2-high",
      name: "SWE-2 High",
      provider: "devin",
      efforts: ["low", "medium", "high", "max"],
      defaultEffort: "max",
    },
    {
      id: "swe-2-max",
      name: "SWE-2 Max",
      provider: "devin",
      efforts: ["low", "medium", "high", "max"],
      defaultEffort: "max",
    },
  ],
  default: "swe-2-high",
  defaultProvider: "devin",
};

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });
  stack = await bootStack("evid-899", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
    LILOS_COMPANY: "0",
  });
});
test.afterAll(async () => {
  await stack?.stop();
});
test.describe.configure({ mode: "serial" });

const devin = { delay: 2_500, fail: false };

/** The same fake as ac-899: an idle, available `acp:devin` row REPLACES
    the real one and `models.list {runtime}` is answered after a beat so
    "Loading models…" is on screen long enough to shoot. */
async function playDevin(page: Page) {
  await page.routeWebSocket(
    new RegExp(`127\\.0\\.0\\.1:${stack.ports.relay}/`),
    (ws) => {
      const server = ws.connectToServer();
      const methods = new Map<unknown, string>();
      ws.onMessage((raw) => {
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        try {
          const f = JSON.parse(text) as {
            id?: unknown;
            method?: string;
            params?: { runtime?: string };
          };
          if (f.method) methods.set(f.id, f.method);
          if (f.method === "models.list" && f.params?.runtime === RT) {
            const frame = devin.fail
              ? { error: { code: -32000, message: "devin not on PATH" } }
              : { result: DEVIN };
            setTimeout(
              () =>
                ws.send(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: f.id ?? null,
                    ...frame,
                  }),
                ),
              devin.delay,
            );
            return;
          }
        } catch {
          /* not JSON — forward */
        }
        server.send(raw);
      });
      server.onMessage((msg) => {
        const text = typeof msg === "string" ? msg : msg.toString("utf8");
        try {
          const f = JSON.parse(text) as {
            id?: unknown;
            result?: { runtimes?: Record<string, unknown>[] };
          };
          if (
            methods.get(f.id) === "system.status" &&
            Array.isArray(f.result?.runtimes)
          ) {
            /* IDLE = no `state` key — "idle" is not an EngineHostState,
               and a wrong one fails the whole status parse. */
            f.result.runtimes = [
              ...f.result.runtimes.filter((r) => r.id !== RT),
              {
                id: RT,
                label: "Devin",
                available: true,
                agentsUpdatable: [
                  "model",
                  "instructions",
                  "soul",
                  "description",
                ],
              },
            ];
            ws.send(JSON.stringify(f));
            return;
          }
        } catch {
          /* not JSON — forward */
        }
        ws.send(msg);
      });
    },
  );
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(OUT, `${name}.png`) });

let devinEmployee = "";
let devinThread = "";

test("hire Devin on its idle runtime and open a thread for it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1288, height: 800 });
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/`);
  const { employee } = await relayRpc<{ employee: { id: string } }>(
    page,
    stack,
    "employees.create",
    {
      name: "Devin",
      role: "Coding agent",
      runtime: RT,
      model: "swe-2-high",
      status: "online",
    },
  );
  devinEmployee = employee.id;
  const { channel } = await relayRpc<{ channel: { id: string } }>(
    page,
    stack,
    "channels.openDm",
    { employeeId: devinEmployee },
  );
  const { conversation } = await relayRpc<{ conversation: { id: string } }>(
    page,
    stack,
    "conversations.open",
    {
      channelId: channel.id,
      text: "check the build",
      model: "swe-2-high",
      provider: "devin",
    },
  );
  devinThread = conversation.id;
});

test("new chat with Devin: Loading models… then SWE-2 High + Max", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1288, height: 800 });
  await skipFirstRun(page);
  await playDevin(page);
  await page.goto(
    `${stack.webUrl}/?statusPollMs=400#?page=threads&open=newchat:${encodeURIComponent(devinEmployee)}`,
  );
  const peek = v3Peek(page);
  await expect(peek.locator('[data-slot="model-chip-loading"]')).toContainText(
    "Loading models…",
    { timeout: 30_000 },
  );
  await shot(page, "newchat-loading");
  await expect(
    peek.locator('[data-slot="model-picker-trigger"]'),
  ).toContainText("SWE-2 High", { timeout: 30_000 });
  await expect(
    peek.locator('[data-slot="effort-picker-trigger"] [data-effort]'),
  ).toHaveText("Max");
  await shot(page, "newchat-loaded");
});

test("the open Devin thread: Loading models… then SWE-2 High + Max", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1288, height: 800 });
  await skipFirstRun(page);
  await playDevin(page);
  await page.goto(
    `${stack.webUrl}/?statusPollMs=400#?page=threads&open=thread:${encodeURIComponent(devinThread)}`,
  );
  const peek = v3Peek(page);
  await expect(peek.locator('[data-slot="model-chip-loading"]')).toContainText(
    "Loading models…",
    { timeout: 30_000 },
  );
  await shot(page, "thread-loading");
  await expect(
    peek.locator('[data-slot="model-picker-trigger"]'),
  ).toContainText("SWE-2 High", { timeout: 30_000 });
  await expect(
    peek.locator('[data-slot="effort-picker-trigger"] [data-effort]'),
  ).toHaveText("Max");
  await shot(page, "thread-loaded");
});

test("Devin's agent page: Default model asks the idle runtime too", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1288, height: 800 });
  await skipFirstRun(page);
  await playDevin(page);
  await page.goto(
    `${stack.webUrl}/?statusPollMs=400#?page=people&open=agent:${encodeURIComponent(devinEmployee)}`,
  );
  const peek = v3Peek(page);
  /* The ask is in flight while the adapter still sleeps. */
  await expect(peek).toContainText("Loading models…", { timeout: 30_000 });
  await shot(page, "agent-loading");
  await expect(peek).toContainText("SWE-2 High", { timeout: 30_000 });
  await expect(peek).not.toContainText("Engine default");
  await shot(page, "agent-loaded");
});

test("a refused catalog ask: Models unavailable with Retry", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1288, height: 800 });
  await skipFirstRun(page);
  devin.fail = true;
  devin.delay = 0;
  await playDevin(page);
  await page.goto(
    `${stack.webUrl}/?statusPollMs=400#?page=threads&open=newchat:${encodeURIComponent(devinEmployee)}`,
  );
  const peek = v3Peek(page);
  await expect(peek.locator('[data-slot="model-chip-failed"]')).toContainText(
    "Models unavailable",
    { timeout: 30_000 },
  );
  await shot(page, "failure-chip");
});
