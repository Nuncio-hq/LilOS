import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { expectSettled } from "./helpers/approvals";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Evidence capture for Group A (#576/#578/#558) — PR #637.
 *
 * Not part of the verify suite: every test here is skipped unless
 * `LILOS_EVIDENCE=1` is set. Run locally to regenerate the PR's screenshots
 * and screen recordings:
 *
 *   LILOS_EVIDENCE=1 bunx playwright test e2e/evidence-group-a.spec.ts
 *
 * Output lands in test-results/evidence/group-a/{576,578,558}/ (the 3x2
 * size/theme matrix) and …/recordings/ (webm).
 */

test.skip(
  process.env.LILOS_EVIDENCE !== "1",
  "evidence capture only — set LILOS_EVIDENCE=1",
);

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const OUT = path.join(repo, "test-results", "evidence", "group-a");

const SIZES = [
  { w: 1288, h: 700 },
  { w: 1288, h: 900 },
  { w: 1440, h: 900 },
];
const THEMES = ["light", "dark"] as const;

let stackA: Stack;
test.beforeAll(async () => {
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });
  for (const d of ["576", "578", "558", "recordings"])
    mkdirSync(path.join(OUT, d), { recursive: true });
  stackA = await bootStack("evid", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
  });
});
test.afterAll(async () => {
  await stackA?.stop();
});

test.describe.configure({ mode: "serial" });

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

async function dmDefault(stack: Stack, page: Page) {
  await page.goto(`${stack.webUrl}/`);
  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 30_000,
  });
  const dmBtn = page.getByRole("button", {
    name: /open dm|set up later|message/i,
  });
  if (
    await dmBtn
      .first()
      .isVisible()
      .catch(() => false)
  )
    await dmBtn.first().click();
  else await aside.getByRole("button", { name: /default/i }).click();
  await expect(page).toHaveURL(/\/dm\//);
}

const shot = (page: Page, dir: string, name: string) =>
  page.screenshot({ path: path.join(OUT, dir, `${name}.png`) });

const RUNNING_HINT = /Enter (steers|queues) · ⌘\. stop/;
/* #585 stripped the wire name — the turn chip renders "Stopped" plain. */
const STOPPED = /^Stopped$/;

/** Each dialog #576 names, shot open, then Esc closed. */
async function dialogsPass(page: Page, tag: string) {
  const close = async (dialog: ReturnType<Page["getByRole"]>) => {
    await page.keyboard.press("Escape");
    await expect(dialog)
      .toHaveCount(0, { timeout: 4_000 })
      .catch(async () => {
        /* a still-mounted menu under the dialog can own the first Esc */
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0, { timeout: 15_000 });
      });
  };

  await page
    .locator("aside")
    .getByRole("button", { name: /hire employee/i })
    .click();
  const hire = page.getByRole("dialog", { name: "Hire an employee" });
  await expect(hire).toBeVisible({ timeout: 15_000 });
  await shot(page, "576", `${tag}-hire`);
  await close(hire);

  await page.locator('[data-ws="folder"]').click();
  await page
    .locator('[role="menu"], [data-slot="dropdown-menu-content"]')
    .last()
    .getByText("Add a folder")
    .click();
  const folder = page.getByRole("dialog", { name: "Add a folder" });
  await expect(folder).toBeVisible({ timeout: 15_000 });
  await shot(page, "576", `${tag}-addfolder`);
  await close(folder);

  await page.getByRole("button", { name: "Pair phone" }).click();
  const pair = page.getByRole("dialog", { name: "Pair phone" });
  await expect(pair).toBeVisible({ timeout: 15_000 });
  await shot(page, "576", `${tag}-pair`);
  await close(pair);

  await page.getByRole("button", { name: "System status" }).click();
  const status = page.getByRole("dialog", { name: "System status" });
  await expect(status).toBeVisible({ timeout: 15_000 });
  await shot(page, "576", `${tag}-status`);
  await close(status);

  await page.getByRole("button", { name: "Profile", exact: true }).click();
  const card = page.getByRole("dialog", { name: /profile$/i });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card
    .getByRole("button", { name: /^Edit$/ })
    .first()
    .click();
  const edit = page.getByRole("dialog", { name: "Edit employee" });
  await expect(edit).toBeVisible({ timeout: 15_000 });
  await shot(page, "576", `${tag}-edit`);
  await close(edit);
  await expect(card).toBeVisible();
  await close(card);
}

/** Rewind hover affordance + Undo toast (#578) + approval-card hint (#558)
    + the running ⌘. stop hint (#576), all on the same seeded thread. */
const lastTurn = (page: Page) => page.locator("[data-agentturn]").last();

async function threadSubjects(page: Page, tag: string) {
  /* Each send waits its turn's settle — a send mid-turn lands in the tray
     and never grows a second user-turn row for the rewind trigger. */
  await send(page, "alpha marker one");
  await expectSettled(lastTurn(page), 60_000);
  await send(page, "beta marker two");
  await expectSettled(lastTurn(page), 60_000);
  const triggers = page.locator("[data-rewind]");
  await expect(triggers).toHaveCount(2, { timeout: 60_000 });
  /* Hover only once the affordance is its settled self — while `running`
     flips off, the span remounts and drops the hover mid-transition. */
  await expect(triggers.nth(1)).toHaveAttribute("title", /Rewind to before/, {
    timeout: 30_000,
  });

  await page
    .locator("[data-userturn]")
    .getByText("beta marker two")
    .hover({ force: true });
  const wrap = triggers.nth(1).locator("..");
  await expect(wrap).toHaveCSS("opacity", "1", { timeout: 15_000 });
  await shot(page, "578", `${tag}-rewind-hover`);

  await triggers.nth(1).click();
  const toast = page.locator("[data-toast]");
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await shot(page, "578", `${tag}-undo-toast`);
  await page.locator("[data-toast-action]").click();
  await expect(toast.getByText(/undone/i)).toBeVisible({ timeout: 15_000 });

  await send(page, "slow:150 update the readme with a release note");
  const askCard = page.locator('[data-ask-id][data-ask-state="open"]').first();
  await expect(askCard).toBeVisible({ timeout: 60_000 });
  await expect(askCard.locator("[data-ask-keyhint]")).toBeVisible({
    timeout: 15_000,
  });
  await shot(page, "558", `${tag}-card-hint`);
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await page.keyboard.press("Enter");

  await send(page, "LILOS_TURN_HOLD Add a release note to the readme");
  await expect(page.getByText(RUNNING_HINT)).toBeVisible({
    timeout: 30_000,
  });
  await shot(page, "576", `${tag}-stop-hint`);
  await page.keyboard.press("Meta+Period");
  await expect(page.getByText(STOPPED)).toBeVisible({ timeout: 30_000 });
}

test("capture the 3x2 size/theme matrix", async ({ browser }) => {
  test.setTimeout(300_000);
  for (const s of SIZES) {
    for (const t of THEMES) {
      const tag = `${s.w}x${s.h}-${t}`;
      const ctx = await browser.newContext({
        viewport: { width: s.w, height: s.h },
        colorScheme: t,
      });
      const page = await ctx.newPage();
      await page.addInitScript(
        (theme) => localStorage.setItem("lilos-theme", theme),
        t,
      );
      await dmDefault(stackA, page);
      await dialogsPass(page, tag);
      await threadSubjects(page, tag);
      await ctx.close();
      console.log(`captured ${tag}`);
    }
  }
});

test("record the rewind→Undo→restore flow", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext({
    viewport: { width: 1288, height: 900 },
    recordVideo: {
      dir: path.join(OUT, "recordings"),
      size: { width: 1288, height: 900 },
    },
  });
  const page = await ctx.newPage();
  await dmDefault(stackA, page);
  await send(page, "alpha marker one");
  await expectSettled(lastTurn(page), 60_000);
  await send(page, "beta marker two");
  await expectSettled(lastTurn(page), 60_000);
  const triggers = page.locator("[data-rewind]");
  await expect(triggers).toHaveCount(2, { timeout: 60_000 });
  await expect(triggers.nth(1)).toHaveAttribute("title", /Rewind to before/, {
    timeout: 30_000,
  });
  await page.waitForTimeout(600);
  await page
    .locator("[data-userturn]")
    .getByText("beta marker two")
    .hover({ force: true });
  await page.waitForTimeout(800); // let the affordance fade in on camera
  await triggers.nth(1).click();
  await expect(page.locator("[data-toast]")).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(1500); // viewer reads the toast
  await page.locator("[data-toast-action]").click();
  await expect(
    page.locator("[data-userturn]").getByText("beta marker two"),
  ).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1200);
  await ctx.close();
});

test("record Esc during a running turn (turn never stops)", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext({
    viewport: { width: 1288, height: 900 },
    recordVideo: {
      dir: path.join(OUT, "recordings"),
      size: { width: 1288, height: 900 },
    },
  });
  const page = await ctx.newPage();
  await dmDefault(stackA, page);
  await send(page, "LILOS_TURN_HOLD Add a release note to the readme");
  await expect(page.getByText(RUNNING_HINT)).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForTimeout(800);
  /* Esc pops one surface per press — Focus → thread → DM landing — while
     the turn keeps running underneath; the session row still says open. */
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+$/, { timeout: 10_000 });
  await page.waitForTimeout(700);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/dm\/[^/]+$/, { timeout: 10_000 });
  await expect(page.getByText("Session running")).toBeVisible({
    timeout: 15_000,
  });
  /* Re-open the still-running session, then ⌘. — the real stop. */
  await page
    .getByRole("button", { name: /Session running/ })
    .first()
    .click();
  await expect(page.getByText(RUNNING_HINT)).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForTimeout(500);
  await page.keyboard.press("Meta+Period");
  await expect(page.getByText(STOPPED)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  await ctx.close();
});
