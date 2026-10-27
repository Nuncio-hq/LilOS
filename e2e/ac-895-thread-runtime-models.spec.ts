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
  startChat,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * Issue #895 — an open thread's composer lists ITS agent's models. A Devin
 * thread (runtime `acp:devin`) shows Devin's catalog, never Hermes's, and
 * `swe-2-high` is a normal checked row. The stack has no real second
 * runtime (e2e never provisions an ACP adapter), so `page.routeWebSocket`
 * plays Devin on the wire: it appends a running `acp:devin` row to
 * `system.status` and answers `models.list {runtime:"acp:devin"}` itself —
 * everything else (Hermes's catalog, the relay, the thread) is the real
 * stack. Paused product (`LILOS_COMPANY: "0"`): no Work/Goals/People.
 *
 *   AC-1 only the runtime's own rows; the pick is a checked row
 *   AC-2 catalog not landed → read-only chip, then the dropdown appears
 *   AC-3 the effort menu lists the runtime's levels for the picked model
 *   AC-4 Refresh re-asks the runtime; no Edit models…
 *   AC-5 a Hermes thread is unchanged
 *
 * `AC895_TAG=before` names the screenshots for a run on the unfixed code.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, "..", "test-results", "ac-895");
const TAG = process.env.AC895_TAG ?? "after";
const RT = "acp:devin";

const DEVIN = {
  models: [
    {
      id: "swe-2-high",
      name: "SWE-2 High",
      provider: "devin",
      efforts: ["low", "thought_level"],
      defaultEffort: "thought_level",
    },
    { id: "swe-2-max", name: "SWE-2 Max", provider: "devin" },
  ],
  default: "swe-2-high",
  defaultProvider: "devin",
};
const FRESH = {
  ...DEVIN,
  models: [
    ...DEVIN.models,
    { id: "swe-2-fresh", name: "SWE-2 Fresh", provider: "devin" },
  ],
};

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  stack = await bootStack("ac895", await pickPorts(), { LILOS_COMPANY: "0" });
});
test.afterAll(async () => {
  await stack?.stop();
});
test.describe.configure({ mode: "serial" });

/** What the fake Devin answers; flipped by the spec. */
const devin = {
  landed: false,
  refreshed: false,
  /** Bumped to change the status row's signature, so the app re-asks. */
  detail: "v1",
  asked: [] as { runtime?: string; refresh?: boolean }[],
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
            params?: { runtime?: string; refresh?: boolean };
          };
          if (f.method) methods.set(f.id, f.method);
          if (f.method === "models.list") {
            devin.asked.push({
              runtime: f.params?.runtime,
              refresh: f.params?.refresh,
            });
            if (f.params?.runtime === RT) {
              if (f.params.refresh) devin.refreshed = true;
              const frame = devin.landed
                ? { result: devin.refreshed ? FRESH : DEVIN }
                : {
                    error: { code: -32000, message: "adapter still starting" },
                  };
              ws.send(
                JSON.stringify({ jsonrpc: "2.0", id: f.id ?? null, ...frame }),
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
            Array.isArray(f.result?.runtimes) &&
            !f.result.runtimes.some((r) => r.id === RT)
          ) {
            f.result.runtimes.push({
              id: RT,
              label: "Devin",
              available: true,
              state: "running",
              detail: devin.detail,
            });
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
  page.screenshot({ path: path.join(SHOTS, `${TAG}-${name}.png`) });

const trigger = (page: Page) =>
  v3Peek(page).locator('[data-slot="model-picker-trigger"]');
const staticChip = (page: Page) =>
  v3Peek(page).locator('[data-slot="model-chip-static"]');

let devinThread = "";

test("the Devin thread opens with Devin's pick as a read-only chip until its catalog lands (AC-2)", async ({
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
  const { channel } = await relayRpc<{ channel: { id: string } }>(
    page,
    stack,
    "channels.openDm",
    { employeeId: employee.id },
  );
  const { conversation } = await relayRpc<{
    conversation: { id: string };
  }>(page, stack, "conversations.open", {
    channelId: channel.id,
    text: "check the build",
    model: "swe-2-high",
    provider: "devin",
  });
  devinThread = conversation.id;

  await playDevin(page);
  await page.goto(
    `${stack.webUrl}/?statusPollMs=500#?page=threads&open=thread:${encodeURIComponent(devinThread)}`,
  );
  await page.reload();

  await expect(staticChip(page)).toContainText(/swe-2-high/i, {
    timeout: 30_000,
  });
  await expect(trigger(page)).toHaveCount(0);
  await expect(v3Peek(page)).not.toContainText("Fake");
  /* Paused product: the sidebar has no Work / Goals / People. */
  for (const name of ["Work", "Goals", "People"])
    await expect(
      v3Sidebar(page).getByRole("button", { name, exact: true }),
    ).toHaveCount(0);
  await shot(page, "1-catalog-pending");
});

test("once the runtime's catalog lands the dropdown lists only its models, with the pick checked and Devin's efforts (AC-1, AC-3)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1288, height: 800 });
  await skipFirstRun(page);
  await playDevin(page);
  devin.landed = true;
  devin.detail = "v2"; // a changed status row is the signal to ask again
  await page.goto(
    `${stack.webUrl}/?statusPollMs=500#?page=threads&open=thread:${encodeURIComponent(devinThread)}`,
  );

  await expect(trigger(page)).toContainText("SWE-2 High", { timeout: 30_000 });
  await expect(staticChip(page)).toHaveCount(0);
  await trigger(page).click();
  const list = page.locator("[cmdk-list]");
  await expect(
    list.locator("[cmdk-item]", { hasText: "SWE-2 Max" }),
  ).toBeVisible();
  const high = list.locator("[cmdk-item]", { hasText: "SWE-2 High" });
  await expect(high).toBeVisible();
  await expect(high).toHaveAttribute("data-checked", "true");
  /* Never a Hermes row, never the "Not in list" escape hatch. */
  await expect(list).not.toContainText("Fake");
  await expect(list).not.toContainText("Not in list");
  await shot(page, "2-dropdown-open");
  await page.keyboard.press("Escape");

  const effort = v3Peek(page).locator('[data-slot="effort-picker-trigger"]');
  await expect(effort).toBeVisible();
  await effort.click();
  const menu = page.getByRole("menu", { name: "Reasoning levels" });
  await expect(menu).toContainText(/thought.?level/i);
  await expect(menu).not.toContainText("Medium");
  await page.keyboard.press("Escape");
});

test("Refresh re-asks the runtime and Edit models… is not offered (AC-4)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1288, height: 800 });
  await skipFirstRun(page);
  await playDevin(page);
  await page.goto(
    `${stack.webUrl}/?statusPollMs=500#?page=threads&open=thread:${encodeURIComponent(devinThread)}`,
  );
  await expect(trigger(page)).toContainText("SWE-2 High", { timeout: 30_000 });
  devin.asked.length = 0;
  await trigger(page).click();
  await expect(page.getByText("Edit models…")).toHaveCount(0);
  await page.getByText("Refresh models").click();
  await expect(
    page.locator("[cmdk-item]", { hasText: "SWE-2 Fresh" }),
  ).toBeVisible({ timeout: 15_000 });
  expect(devin.asked).toContainEqual({ runtime: RT, refresh: true });
  /* Hermes's catalog was not the one refreshed. */
  expect(devin.asked.filter((a) => a.refresh && !a.runtime)).toHaveLength(0);
});

test("a Hermes thread keeps Hermes's catalog, grouped, with Edit models… (AC-5)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1288, height: 800 });
  await skipFirstRun(page);
  await playDevin(page);
  await startChat(
    page,
    stack.webUrl,
    { id: "default", name: "Hermes" },
    "hello from hermes",
  );
  await expect(trigger(page)).toContainText("Fake", { timeout: 60_000 });
  await trigger(page).click();
  await expect(page.getByRole("group", { name: "Fake" })).toBeVisible();
  await expect(page.getByText("Edit models…")).toBeVisible();
  await expect(page.locator("[cmdk-list]")).not.toContainText("SWE-2");
});
