import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectSettled } from "./helpers/approvals";
import {
  bootStack,
  panelIntoFocus,
  pickPorts,
  type Stack,
  skipFirstRun,
  startChat,
  v3Peek,
} from "./helpers/stack";

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
 *
 * v3: the flows are the ported ac-576/ac-578/ac-558 ones. A chat starts from
 * the new-chat draft beside Threads and its thread opens in the side peek;
 * the rewind/ask-key shots need `[data-userturn]` rows, which are the session
 * view's (the peek widened, `full=1`). Of the dialogs #576 names, the ones
 * that are still dialogs are shot: Search (⌘K), the shortcut list (⌘/), "Add
 * a folder" (the folder-less thread header's link) and System status (the
 * banner's Details, which only draws while a leg is down, so a second stack
 * on an engine that cannot start supplies it). Hire and Pair phone are pages
 * now and Edit employee / the Profile card are gone, so Esc has nothing to
 * close there and they are not harvested.
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
/* System status only draws while a leg is down: an engine that cannot start
   — the same dead-engine shape ac-576 and the #85/#589 e2e drive. */
let stackDead: Stack;
test.beforeAll(async () => {
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });
  for (const d of ["576", "578", "558", "recordings"])
    mkdirSync(path.join(OUT, d), { recursive: true });
  stackA = await bootStack("evid", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
  });
  stackDead = await bootStack("evidead", await pickPorts(), {
    LILOS_ENGINE: "hermes",
    HERMES_BIN: "/nonexistent/hermes-bin",
  });
});
test.afterAll(async () => {
  await stackA?.stop();
  await stackDead?.stop();
});

test.describe.configure({ mode: "serial" });

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

/** A new chat with the seeded Default employee, the way a person starts one:
    the draft beside Threads, then the thread in the side peek. An id that
    names nobody opens the draft on the default agent. */
async function chatDefault(page: Page, text: string) {
  await skipFirstRun(page);
  await startChat(page, stackA.webUrl, { id: "default", name: "Hermes" }, text);
}

const shot = (page: Page, dir: string, name: string) =>
  page.screenshot({ path: path.join(OUT, dir, `${name}.png`) });

const RUNNING_HINT = /Enter (steers|queues) · ⌘\. stop/;
/* #585 stripped the wire name — the turn chip renders "Stopped" plain. */
const STOPPED = /^Stopped$/;

/** Each dialog #576 names that is still a dialog, shot open, then Esc closed.
    The thread is open beside Threads (the peek) while the dialogs open; only
    the dialog may close on each Esc. */
async function dialogsPass(
  page: Page,
  tag: string,
  theme: (typeof THEMES)[number],
) {
  const close = async (dialog: Locator) => {
    await page.keyboard.press("Escape");
    await expect(dialog)
      .toHaveCount(0, { timeout: 4_000 })
      .catch(async () => {
        /* a still-mounted menu under the dialog can own the first Esc */
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0, { timeout: 15_000 });
      });
    // Only the top layer closed: the thread is still open beside the list.
    await expect(page.locator("[data-thread-panel]")).toBeVisible();
  };

  await page.keyboard.press("Meta+k");
  const search = page.getByRole("dialog", { name: "Search" });
  await expect(search).toBeVisible({ timeout: 15_000 });
  await shot(page, "576", `${tag}-search`);
  await close(search);

  await page.locator("[data-add-folder]").click();
  const folder = page.getByRole("dialog", { name: "Add a folder" });
  await expect(folder).toBeVisible({ timeout: 15_000 });
  await shot(page, "576", `${tag}-addfolder`);
  await close(folder);

  await page.keyboard.press("Meta+/");
  const shortcuts = page.locator("[data-shortcuts-dialog]");
  await expect(shortcuts).toBeVisible({ timeout: 15_000 });
  await shot(page, "576", `${tag}-shortcuts`);
  await close(shortcuts);

  /* System status: the dead-engine stack's banner, in a page of the same
     context (same size and colour scheme). */
  const dead = await page.context().newPage();
  try {
    await skipFirstRun(dead);
    await dead.addInitScript(
      (t) => localStorage.setItem("lilos-theme", t),
      theme,
    );
    await dead.goto(`${stackDead.webUrl}/`);
    await dead
      .getByRole("status")
      .getByRole("button", { name: "Details" })
      .click({ timeout: 90_000 });
    const status = dead.getByRole("dialog", { name: "System status" });
    await expect(status).toBeVisible({ timeout: 15_000 });
    await shot(dead, "576", `${tag}-status`);
    await dead.keyboard.press("Escape");
    await expect(status).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await dead.close();
  }
}

/** Rewind hover affordance + Undo toast (#578) + approval-card hint (#558)
    + the running ⌘. stop hint (#576), all on the same seeded thread. */
const lastTurn = (page: Page) => page.locator("[data-agentturn]").last();

/** The thread is already open in the peek with its first message sent; the
    session view (the peek widened) is where the user rows the rewind trigger
    lives on render. */
async function threadSubjects(page: Page, tag: string) {
  await panelIntoFocus(page);
  /* Each send waits its turn's settle — a send mid-turn lands in the tray
     and never grows a second user-turn row for the rewind trigger. */
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
  test.setTimeout(900_000);
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
      await chatDefault(page, "alpha marker one");
      await dialogsPass(page, tag, t);
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
  await chatDefault(page, "alpha marker one");
  await panelIntoFocus(page);
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
  await chatDefault(page, "LILOS_TURN_HOLD Add a release note to the readme");
  await expect(page.getByText(RUNNING_HINT)).toBeVisible({
    timeout: 30_000,
  });
  /* Hop into the session view so the walk has every layer: widened → peek →
     Threads list. */
  await panelIntoFocus(page);
  await page.waitForTimeout(800);
  /* Esc pops one surface per press — session view → thread beside the list →
     the Threads list — while the turn keeps running underneath; the thread's
     board card still reads Working. */
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/full=1/, { timeout: 10_000 });
  await expect(page).toHaveURL(/open=thread:[^&]+$/);
  await page.waitForTimeout(700);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/page=threads$/, { timeout: 10_000 });
  await expect(v3Peek(page)).toHaveCount(0);
  const card = page
    .locator("#v3-main")
    .getByRole("button")
    .filter({ hasText: /release note/i });
  await expect(card.getByText("Working", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  /* Re-open the still-running thread, then ⌘. — the real stop. */
  await card
    .getByText(/release note/i)
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
