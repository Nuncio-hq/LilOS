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
 * the row has room, and collapse to non-overlapping icons when it has not.
 * Oscar's labels: Hermes, No project, a model, "Extra high", "Never asks"
 * (`LILOS_FAKE_POLICY=off`). The fake's "Fake Reasoning" (14 chars) stands
 * in for "Opus 5.5" (8) — a stricter case. Skipped unless `LILOS_EVIDENCE=1`:
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
  /* LILOS_COMPANY=0: the sidebar shows no Work/Goals/People (Oscar's view).
     LILOS_FAKE_POLICY=off: the access chip reads "Never asks". */
  stack = await bootStack("evid-897", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
    LILOS_COMPANY: "0",
    LILOS_FAKE_POLICY: "off",
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

const composer = (page: Page) =>
  page.locator("[data-composer]:visible").first();

/** Every chip label in the row: the text it shows vs the text it has. */
async function labels(page: Page) {
  return composer(page).evaluate((box) =>
    [...box.querySelectorAll("button span, [data-composer] span")]
      .filter((s) => s.children.length === 0 && s.textContent?.trim())
      .map((s) => ({
        text: s.textContent?.trim() ?? "",
        clipped: s.scrollWidth > s.clientWidth,
        shown: s.getClientRects().length > 0 && s.clientWidth > 0,
      })),
  );
}

/** The chips and the Send button as boxes: none may overlap or leave the
 *  composer. */
async function boxes(page: Page) {
  return composer(page).evaluate((box) => {
    const frame = box.getBoundingClientRect();
    return [...box.querySelectorAll("button")]
      .filter((b) => b.getClientRects().length > 0)
      .map((b) => {
        const r = b.getBoundingClientRect();
        return {
          name: b.getAttribute("title") || b.textContent?.trim() || "?",
          l: r.left,
          r: r.right,
          inside: r.left >= frame.left - 0.5 && r.right <= frame.right + 0.5,
        };
      });
  });
}

async function expectNoOverlap(page: Page) {
  const bs = (await boxes(page)).sort((a, b) => a.l - b.l);
  for (const b of bs)
    expect(b.inside, `"${b.name}" leaves the composer`).toBe(true);
  for (let i = 1; i < bs.length; i++)
    expect(
      bs[i].l,
      `"${bs[i].name}" overlaps "${bs[i - 1].name}"`,
    ).toBeGreaterThanOrEqual(bs[i - 1].r - 0.5);
}

/** Oscar's longest labels: the model with the longest name, effort "Extra
 *  high". Picks through the visible chips, as he would. */
async function pickLongLabels(page: Page, effort = true) {
  const scope = composer(page);
  await scope.locator('[data-slot="model-picker-trigger"]').click();
  await page.locator("[cmdk-item]", { hasText: "Fake Reasoning" }).click();
  if (!effort) return;
  await scope.locator('[data-slot="effort-picker-trigger"]').click();
  await page.getByRole("menuitemradio", { name: "Extra high" }).click();
  await expect(scope.locator("[data-effort]")).toHaveText("Extra high");
}

async function newChat(page: Page, width: number, expand: boolean) {
  await page.addInitScript(() => localStorage.setItem("lilos-theme", "dark"));
  await page.setViewportSize({ width, height: 800 });
  await openNewChat(page, stack.webUrl);
  await expect(
    v3Peek(page).locator('[data-slot="model-picker-trigger"]'),
  ).toBeVisible({ timeout: 30_000 });
  if (expand)
    await page.getByRole("button", { name: "Widen over the page" }).click();
  await pickLongLabels(page, width >= 900);
}

async function shoot(page: Page, name: string, full: boolean, who?: string) {
  const ls = await labels(page);
  const w = await composer(page).evaluate((b) => b.clientWidth);
  console.log(`[897] ${name} composer ${w}px`, JSON.stringify(ls));
  await page.screenshot({
    path: path.join(OUT, `${name}.png`),
    animations: "disabled",
  });
  if (full) {
    for (const l of ls.filter((x) => x.shown))
      expect(l.clipped, `"${l.text}" is clipped`).toBe(false);
    for (const t of [who, "Fake Reasoning", "Extra high", "Never asks"].filter(
      Boolean,
    ) as string[])
      expect(
        ls.some((l) => l.text.includes(t) && l.shown),
        `"${t}" is not shown`,
      ).toBe(true);
  }
  await expectNoOverlap(page);
}

for (const [name, width, expand] of [
  ["new-chat-expanded-945", 945, true],
  ["new-chat-wide-1400", 1400, false],
  ["new-chat-narrow-700", 700, false],
] as const) {
  test(name, async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext({
      viewport: { width, height: 800 },
      colorScheme: "dark",
    });
    const page = await ctx.newPage();
    await newChat(page, width, expand);
    await shoot(page, name, width >= 900, "Hermes");
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
  await pickLongLabels(page);
  await shoot(page, "open-thread-wide-1400", true);
  await ctx.close();
});
