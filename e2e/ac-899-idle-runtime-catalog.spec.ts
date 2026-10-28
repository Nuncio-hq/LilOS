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
 * Issue #899 — a runtime agent's screen asks ITS runtime's catalog even
 * while the adapter is idle. After a restart Devin's engine is
 * `available: true` but not running, and until this fix nothing ever sent
 * `models.list {runtime:"acp:devin"}`: every Devin surface read "Engine
 * default". Boot still asks nothing (D-#866); OPENING a Devin screen —
 * the new chat with Devin selected, a Devin thread, Devin's agent page —
 * sends the ask that lazy-starts the adapter (D-#761).
 *
 * `page.routeWebSocket` plays Devin on the wire: the `system.status`
 * answer's real `acp:devin` row is REPLACED (CI reports it unavailable —
 * "devin not on PATH" — appending would leave two) with an idle,
 * available row, and `models.list {runtime:"acp:devin"}` is answered
 * after a beat so "Loading models…" is observable. Everything else —
 * Hermes's catalog, the relay, the thread — is the real stack. Paused
 * product (`LILOS_COMPANY: "0"`).
 *
 *   AC-1 the Devin screens' model UI names SWE-2 High and effort Max
 *   AC-2 while the ask is in flight: "Loading models…", never a guess
 *   AC-3 the picker lists only Devin's own rows
 *   AC-4 a refused ask: "Models unavailable" + Retry re-asks
 *   AC-5 a Devin thread asks the same way
 *   AC-6 the agent page's Default model row asks the same way
 *   AC-7 boot without opening a Devin screen sends no Devin models.list
 *   AC-8 an answered catalog names its real models, never "Engine default"
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, "..", "test-results", "ac-899");
const RT = "acp:devin";

/* Devin's real catalog: the launch spec pins swe-2-high at effort "max",
   and models.list reports that spec default on every row (D-#899). */
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
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  stack = await bootStack("ac899", await pickPorts(), { LILOS_COMPANY: "0" });
});
test.afterAll(async () => {
  await stack?.stop();
});
test.describe.configure({ mode: "serial" });

/** What the fake Devin does; each test sets it before opening a screen. */
const devin = {
  /** Milliseconds before a catalog answer leaves — the loading beat. */
  delay: 0,
  fail: false,
  asked: [] as { runtime?: string }[],
};

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
          if (f.method === "models.list") {
            devin.asked.push({ runtime: f.params?.runtime });
            if (f.params?.runtime === RT) {
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
            /* Replace, never append: the real relay (CI) already reports
               `acp:devin` — unavailable there — and the app reads the
               first row with the id. IDLE and available: `state` is
               EngineHostState ("running"|…|"stopped") — an idle row omits
               it entirely; anything else fails the status parse and the
               whole roster would read empty. */
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
  page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

const peek = (page: Page) => v3Peek(page);
const devinAsks = () => devin.asked.filter((a) => a.runtime === RT).length;

/** The Devin agent exists once per stack — the first test's hire is the
    record the others open screens against. */
let devinEmployee = "";

async function hireDevin(page: Page) {
  if (devinEmployee) return;
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
}

test("boot alone never asks an idle runtime for its catalog (AC-7)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1288, height: 800 });
  await skipFirstRun(page);
  await hireDevin(page);
  devin.asked.length = 0;
  await playDevin(page);
  await page.goto(`${stack.webUrl}/?statusPollMs=400#?page=threads`);
  /* Several status ticks — the app's own poll — with Devin hired, idle
     and available: no models.list may name it. The harness waits for a
     poll cycle plus slack, then the list itself answers. */
  await page.waitForTimeout(2_500);
  expect(devinAsks()).toBe(0);
});

test("opening a new chat with Devin asks the idle runtime; Loading, then its own catalog and effort (AC-1, AC-2, AC-3, AC-8)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1288, height: 800 });
  await skipFirstRun(page);
  await hireDevin(page);
  devin.asked.length = 0;
  devin.delay = 4000;
  devin.fail = false;
  await playDevin(page);
  await page.goto(
    `${stack.webUrl}/?statusPollMs=400#?page=threads&open=newchat:${encodeURIComponent(devinEmployee)}`,
  );
  /* The screen opened — the idle runtime gets asked even so. */
  await expect(
    peek(page).locator('[data-slot="model-chip-loading"]'),
  ).toContainText("Loading models…", { timeout: 30_000 });
  await shot(page, "1-newchat-loading");
  await expect.poll(devinAsks, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);

  /* The answer names Devin's own models — the picker's full control with
     the catalog's own words, never "Engine default" or Hermes's rows. */
  const trigger = peek(page).locator('[data-slot="model-picker-trigger"]');
  await expect(trigger).toContainText("SWE-2 High", { timeout: 30_000 });
  await expect(peek(page)).not.toContainText("Engine default");
  const effort = peek(page).locator('[data-slot="effort-picker-trigger"]');
  await expect(effort.locator("[data-effort]")).toHaveText("Max");
  await trigger.click();
  const list = page.locator("[cmdk-list]");
  await expect(
    list.locator("[cmdk-item]", { hasText: "SWE-2 Max" }),
  ).toBeVisible();
  await expect(list).not.toContainText("Fake");
  await page.keyboard.press("Escape");
  await shot(page, "2-newchat-loaded");
});

test("opening a Devin thread asks the same way (AC-5)", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1288, height: 800 });
  await skipFirstRun(page);
  await hireDevin(page);
  await page.goto(`${stack.webUrl}/`); // an origin for the rpc sockets
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
  devin.asked.length = 0;
  devin.delay = 4000;
  devin.fail = false;
  await playDevin(page);
  await page.goto(
    `${stack.webUrl}/?statusPollMs=400#?page=threads&open=thread:${encodeURIComponent(conversation.id)}`,
  );

  await expect(
    peek(page).locator('[data-slot="model-chip-loading"]'),
  ).toContainText("Loading models…", { timeout: 30_000 });
  await shot(page, "3-thread-loading");
  await expect.poll(devinAsks, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);

  const trigger = peek(page).locator('[data-slot="model-picker-trigger"]');
  await expect(trigger).toContainText("SWE-2 High", { timeout: 30_000 });
  await expect(
    peek(page).locator('[data-slot="effort-picker-trigger"] [data-effort]'),
  ).toHaveText("Max");
  await expect(peek(page)).not.toContainText("Engine default");
  await shot(page, "4-thread-loaded");
});

test("opening Devin's agent page asks the same way; Default model lands (AC-6)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1288, height: 800 });
  await skipFirstRun(page);
  await hireDevin(page);
  devin.asked.length = 0;
  devin.delay = 4000;
  devin.fail = false;
  await playDevin(page);
  await page.goto(
    `${stack.webUrl}/?statusPollMs=400#?page=people&open=agent:${encodeURIComponent(devinEmployee)}`,
  );

  /* The ask goes out even though the adapter sleeps. */
  await expect.poll(devinAsks, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  /* While the answer is in flight the row may read Loading; once it lands
     the record's model reads in the catalog's own words — never
     "Engine default". */
  await expect(peek(page)).toContainText("SWE-2 High", { timeout: 30_000 });
  await expect(peek(page)).not.toContainText("Engine default");
  await shot(page, "5-agent-loaded");
});

test("a refused ask reads Models unavailable and Retry re-asks (AC-4)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1288, height: 800 });
  await skipFirstRun(page);
  await hireDevin(page);
  devin.asked.length = 0;
  devin.delay = 0;
  devin.fail = true;
  await playDevin(page);
  await page.goto(
    `${stack.webUrl}/?statusPollMs=400#?page=threads&open=newchat:${encodeURIComponent(devinEmployee)}`,
  );

  const failed = peek(page).locator('[data-slot="model-chip-failed"]');
  await expect(failed).toContainText("Models unavailable", {
    timeout: 30_000,
  });
  await expect(peek(page)).not.toContainText("Engine default");
  await shot(page, "6-failure-chip");

  /* Retry forgets the refusal and asks again — the recovery lands the
     real catalog. */
  const before = devinAsks();
  devin.fail = false;
  await failed.click();
  await expect.poll(devinAsks, { timeout: 15_000 }).toBeGreaterThan(before);
  await expect(
    peek(page).locator('[data-slot="model-picker-trigger"]'),
  ).toContainText("SWE-2 High", { timeout: 30_000 });
});
