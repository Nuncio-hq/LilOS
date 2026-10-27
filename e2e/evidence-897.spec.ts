import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  openNewChat,
  openSession,
  pickPorts,
  type Stack,
  startFolderlessChat,
  v3Peek,
} from "./helpers/stack";

/**
 * Evidence + measurement for #897 — composer chip labels show in full when
 * the row has room. Skipped unless `LILOS_EVIDENCE=1`:
 *
 *   LILOS_EVIDENCE=1 LILOS_EVIDENCE_OUT=/tmp/e897/after \
 *     bunx playwright test e2e/evidence-897.spec.ts
 */
test.skip(
  process.env.LILOS_EVIDENCE !== "1",
  "evidence capture only — set LILOS_EVIDENCE=1",
);

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT =
  process.env.LILOS_EVIDENCE_OUT ??
  path.join(here, "..", "test-results", "evidence", "897");

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(300_000);
  /* LILOS_COMPANY=0: the sidebar shows no Work/Goals/People (Oscar's view). */
  stack = await bootStack("evid-897", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
    LILOS_COMPANY: "0",
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

/** Every chip label in the row: the text it shows vs the text it has. */
async function labels(page: Page) {
  return page
    .locator("[data-composer]:visible")
    .first()
    .evaluate((box) =>
      [...box.querySelectorAll("button span")]
        .filter((s) => s.children.length === 0 && s.textContent?.trim())
        .map((s) => ({
          text: s.textContent?.trim() ?? "",
          clipped: s.scrollWidth > s.clientWidth,
          shown: s.getClientRects().length > 0 && s.clientWidth > 0,
        })),
    );
}

for (const [name, width] of [
  ["wide", 1400],
  ["narrow", 700],
] as const) {
  test(`new chat ${name}`, async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({
      viewport: { width, height: 800 },
      colorScheme: "dark",
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => localStorage.setItem("lilos-theme", "dark"));
    await openNewChat(page, stack.webUrl);
    await expect(
      v3Peek(page).locator('[data-slot="effort-picker-trigger"]'),
    ).toBeVisible({ timeout: 30_000 });
    const ls = await labels(page);
    console.log(`[897] ${name}`, JSON.stringify(ls));
    await page.screenshot({
      path: path.join(OUT, `new-chat-${name}.png`),
      animations: "disabled",
    });
    if (name === "wide")
      for (const l of ls.filter((x) => x.shown))
        expect(l.clipped, `"${l.text}" is clipped`).toBe(false);
    await ctx.close();
  });
}

test("open thread wide", async ({ browser }) => {
  test.setTimeout(300_000);
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 800 },
    colorScheme: "dark",
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem("lilos-theme", "dark"));
  const id = await startFolderlessChat(page, stack, "Hi there");
  await openSession(page, stack.webUrl, id);
  await expect(
    page.locator('[data-slot="effort-picker-trigger"]:visible'),
  ).toBeVisible({ timeout: 30_000 });
  const ls = await labels(page);
  console.log("[897] thread", JSON.stringify(ls));
  await page.screenshot({
    path: path.join(OUT, "open-thread-wide.png"),
    animations: "disabled",
  });
  for (const l of ls.filter((x) => x.shown))
    expect(l.clipped, `"${l.text}" is clipped`).toBe(false);
  await ctx.close();
});
