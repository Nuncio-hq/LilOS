import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, type Stack } from "./helpers/stack";
import { wport } from "./ports";

/**
 * AC-140: the picker always shows the model the session runs, even when the
 * engine's catalog omits it (the Hermes/Astra case, reproduced deterministically
 * on engine-fake).
 *
 * The scenario: a session opens on `fake-fresh` — engine-fake's refresh-only
 * model — so a normal `models.list` omits it. The picker must show it anyway
 * (AC-1), its row carries the "Not in list · Refresh" hint that runs
 * `models.list {refresh:true}` (AC-2), and once the engine offers it,
 * switching away and back works with no MODEL_NOT_FOUND (AC-2). The warn-on-
 * switch-away dialog (AC-3) is unit-tested in packages/ui/test/model-picker.
 *
 * Real stack (relay + harness + engine-fake + vite dev for apps/web), same
 * helpers as ac-92. The conversation is opened via relay JSON-RPC
 * (`conversations.open {model:"fake-fresh"}`) — the UI only offers listed
 * models by design, which is the premise being tested.
 */
const ROOT = path.dirname(fileURLToPath(import.meta.url)).replace(/\/e2e$/, "");
const SHOTS = path.join(ROOT, "test-results", "ac-140");
const RELAY = wport(4805);
const FEED = wport(4806);
const WEBP = wport(5307);

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack(
    "ac140",
    { relay: RELAY, feed: FEED, web: WEBP },
    { LILOS_ENGINE: "fake" },
  );
});
test.afterAll(async () => {
  await stack?.stop();
});

/** Bare JSON-RPC client — e2e runs under Node without workspace deps. */
async function rpc(
  home: string,
  relayPort: number,
  calls: { method: string; params: Record<string, unknown> }[],
): Promise<Record<string, unknown>[]> {
  const token = readFileSync(path.join(home, "relay-token"), "utf8").trim();
  const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws connect failed"));
  });
  const pending = new Map<string, (r: Record<string, unknown>) => void>();
  ws.onmessage = (e) => {
    const f = JSON.parse(e.data as string) as Record<string, unknown>;
    if (typeof f.id === "string") pending.get(f.id)?.(f);
  };
  const send = (id: string, method: string, params: object) =>
    new Promise<Record<string, unknown>>((res, rej) => {
      pending.set(id, (f) =>
        f.error ? rej(f.error) : res(f.result as Record<string, unknown>),
      );
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  await send("h", "session.hello", { protocolVersion: 1, token });
  const out: Record<string, unknown>[] = [];
  for (const [i, c] of calls.entries())
    out.push(await send(String(i), c.method, c.params));
  ws.close();
  return out;
}

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

const triggers = (page: Page) =>
  page.locator('[data-slot="model-picker-trigger"]');

/** Open a trigger's popover and drill into the searchable model list. */
async function openModelList(page: Page, which: "first" | "last" = "last") {
  await triggers(page)[which]().click();
  await page.getByRole("button", { name: /Model$/ }).click();
}

const option = (page: Page, name: string) =>
  page.locator("[cmdk-item]", { hasText: name });

test("AC-1 + AC-2 a session on a catalog-absent model: hint → Refresh → switch away → switch back", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors = watchConsole(page);

  /* A conversation pinned to the refresh-only model at open — the same
     stamp Hermes sessions get on Oscar's Mac when Astra isn't in the
     cached catalog. */
  await page.goto(`${stack.webUrl}/`);
  const aside = page.locator("aside").first();
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 30_000,
  });
  const firstRun = page.getByRole("button", { name: /open dm/i });
  if (await firstRun.isVisible().catch(() => false)) {
    await firstRun.click();
  } else {
    await aside.getByRole("button", { name: /default/i }).click();
  }
  await expect(page).toHaveURL(/\/dm\/[^/]+/, { timeout: 15_000 });
  const employeeId = page.url().match(/\/dm\/([^/]+)/)?.[1];
  if (!employeeId) throw new Error("no employee id in url");
  const dm = await rpc(stack.home, RELAY, [
    { method: "channels.openDm", params: { employeeId } },
  ]);
  const channelId = (dm[0] as { channel: { id: string } }).channel.id;
  const opened = await rpc(stack.home, RELAY, [
    {
      method: "conversations.open",
      params: {
        channelId,
        text: "first message on the unlisted model",
        model: "fake-fresh",
        provider: "fake",
      },
    },
  ]);
  const conv = (opened[0] as { conversation: { id: string } }).conversation;

  // The picker shows what the session actually runs — the catalog doesn't
  // list it, but the trigger and the checked row do.
  await page.goto(`${stack.webUrl}/dm/${employeeId}/${conv.id}/focus`);
  const trigger = triggers(page).last();
  await expect(trigger).toContainText("fake-fresh", { timeout: 30_000 });

  await openModelList(page);
  const row = option(page, "fake-fresh");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Not in list");
  // The other catalog rows carry no hint.
  await expect(
    page.locator("[cmdk-item]", { hasText: "Not in list" }),
  ).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/ac-1-hint-light.png` });
  // The hint row in dark mode (it must read on both themes).
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.screenshot({ path: `${SHOTS}/ac-1-hint-dark.png` });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));

  /* The row itself is the path back (decision C): clicking it runs
     models.list {refresh:true}. The engine now offers fake-fresh — the hint
     is gone and the catalog name renders. */
  await row.click();
  await expect(option(page, "Fake Fresh")).toHaveCount(1);
  await expect(
    page.locator("[cmdk-item]", { hasText: "Not in list" }),
  ).toHaveCount(0);
  await expect(trigger).toContainText("Fake Fresh");
  await page.screenshot({ path: `${SHOTS}/ac-2-after-refresh.png` });

  // Switch away to a catalog model — no warning: the engine now offers it.
  await option(page, "Fake Opus 2").click();
  await expect(page.getByText("can't switch back")).toHaveCount(0);
  await expect(trigger).toContainText("Fake Opus 2");
  await page.keyboard.press("Escape");

  // Switch back — session.setModel accepts it post-refresh (AC-2, the
  // engine-hermes validation retry mirrored on the fake).
  await openModelList(page);
  await option(page, "Fake Fresh").click();
  await expect(trigger).toContainText("Fake Fresh");
  await page.keyboard.press("Escape");

  /* The trigger shows the pick optimistically; the send races the
     conversations.setModel round-trip on slow runners — wait for the pin
     to land before typing or the turn stamps the old model. */
  await expect
    .poll(
      async () => {
        const rows = await rpc(stack.home, RELAY, [
          { method: "conversations.list", params: { channelId } },
        ]);
        const { conversations } = rows[0] as {
          conversations: { id: string; model?: string }[];
        };
        return conversations.find((c) => c.id === conv.id)?.model;
      },
      { timeout: 30_000 },
    )
    .toBe("fake-fresh");

  // The next turn really runs on it (the footer stamps the turn's model).
  const box = page.locator("textarea").last();
  await box.fill("back on the refreshed model");
  await box.press("Enter");
  const lastTurn = page.locator("[data-agentturn]").last();
  try {
    /* Settle first — the model footer only renders once the turn has ended,
       so a still-running turn keeps this wait honest (and tells "turn never
       finished" apart from "finished on the wrong model"). */
    await expect(lastTurn.locator("[data-turnsettled]")).toBeVisible({
      timeout: 90_000,
    });
    await expect(lastTurn.locator("[data-turnsettled]")).toContainText(
      "Fake Fresh",
    );
  } catch (e) {
    const turns = await page.locator("[data-agentturn]").allInnerTexts();
    const settled = await page
      .locator("[data-turnsettled]")
      .allInnerTexts()
      .catch(() => [] as string[]);
    const state = await rpc(stack.home, RELAY, [
      { method: "conversations.list", params: { channelId } },
    ]).catch(() => null);
    console.log("[ac140 diag] url:", page.url());
    console.log("[ac140 diag] console errors:", JSON.stringify(errors));
    console.log(
      "[ac140 diag] turns:",
      turns.map((t) => t.slice(0, 300)),
    );
    console.log("[ac140 diag] settled:", settled);
    console.log(
      "[ac140 diag] conv:",
      JSON.stringify(
        state?.[0] &&
          (state[0] as { conversations: { id: string }[] }).conversations.find(
            (c) => c.id === conv.id,
          ),
      ),
    );
    throw e;
  }
  await page.screenshot({ path: `${SHOTS}/ac-2-switched-back.png` });
  expect(errors).toEqual([]);
});
