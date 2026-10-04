import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { allowAllWhile, expectSettled } from "./helpers/approvals";
import { bootStack } from "./helpers/stack";
import { wport } from "./ports";

/**
 * Issue #320 — a turn's collapsible blocks open themselves while it runs,
   but only by DEFAULT: the user's first click wins for the rest of the turn.
   Collapsing the steps block mid-run keeps it collapsed while more steps
   land, the parked approval card still shows (it renders outside the block),
   and at turn end the block folds to "N steps" unless the user opened it. */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-320");

/* Each step card is itself a collapsible — the block's own trigger/panel are
   the FIRST matches inside [data-tasksteps]; when the block collapses every
   nested panel unmounts, so a plain count still proves closed. */
const PANEL = '[data-tasksteps] [data-slot="collapsible-content"]';
const TRIGGER = '[data-tasksteps] [data-slot="collapsible-trigger"]';

async function dmDefault(stack: { webUrl: string }, page: Page) {
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
  ) {
    await dmBtn.first().click();
  } else {
    await aside.getByRole("button", { name: /default/i }).click();
  }
  await expect(page).toHaveURL(/\/dm\//);
}

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

test("AC-1/2/3 collapsing a running turn's steps stays collapsed; approval stays visible", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stack = await bootStack(
    "collapse",
    {
      relay: wport(4663),
      feed: wport(4664),
      /* Suite-saturated: all 100 residues are taken (ports.spec gates it),
       so reuse literals other spec files already own — identical bases
       are safe since two specs never share a worker index. */
      web: wport(5241),
    },
    {
      LILOS_USER_NAME: "Oscar",
    },
  );
  try {
    await dmDefault(stack, page);
    // An edit-ask prompt parks the turn on an approval — deterministic
    // running state with a steps block auto-opened.
    await send(page, "Add a release note to the readme");
    const turn = page.locator("[data-agentturn]").last();
    await expect(turn.locator("[data-tasksteps]")).toBeVisible({
      timeout: 60_000,
    });
    // Auto-open as today: the steps panel is expanded while the turn runs.
    await expect(turn.locator(PANEL)).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/steps-autoopen.png` });

    // Click the header — it collapses even though the turn is still running.
    await turn.locator(TRIGGER).first().click();
    await expect(turn.locator(PANEL)).toHaveCount(0);
    // The collapsed header still shows the live state (running tool / pulse).
    await expect(turn.locator("[data-tasksteps]")).toContainText(/…|steps/);

    // AC-2: the parked approval renders outside the collapsed block — it's
    // visible and answerable while the steps stay folded.
    await expect(page.getByText("Approval needed").first()).toBeVisible({
      timeout: 30_000,
    });
    await page.screenshot({ path: `${SHOTS}/collapsed-approval-visible.png` });

    // Keep answering approvals until the turn settles; the whole time the
    // block must stay collapsed (new steps must not re-open it).
    const staysCollapsed = (async () => {
      for (;;) {
        const settled = await turn.locator("[data-turnsettled]").count();
        if (settled > 0) return;
        const open = await turn.locator(PANEL).count();
        if (open > 0)
          throw new Error("steps block re-opened while the turn ran");
        await page.waitForTimeout(150);
      }
    })();
    await allowAllWhile(page, staysCollapsed);
    await expectSettled(turn);
    // More than one step landed while it was collapsed, and at turn end it
    // folded to "N steps" (the user never re-opened it).
    await expect(turn.locator("[data-tasksteps]")).toContainText(/\d+ steps?/);
    await expect(turn.locator(PANEL)).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/settled-collapsed.png` });

    // The block still toggles normally afterwards.
    await turn.locator(TRIGGER).first().click();
    await expect(turn.locator(PANEL)).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/settled-reopened.png` });
  } finally {
    await stack.stop();
  }
});

test("AC-3 a user-opened steps block stays open through turn end", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stack = await bootStack(
    "collapse-open",
    {
      relay: wport(4667),
      feed: wport(4668),
      web: wport(5349),
    },
    {
      LILOS_USER_NAME: "Oscar",
    },
  );
  try {
    await dmDefault(stack, page);
    await send(page, "Add a release note to the readme");
    const turn = page.locator("[data-agentturn]").last();
    await expect(turn.locator("[data-tasksteps]")).toBeVisible({
      timeout: 60_000,
    });
    await expect(turn.locator(PANEL)).toBeVisible({ timeout: 30_000 });

    /* Collapse → re-open while running: the second click marks the block
       user-opened, and it must survive the turn's end (the live row's id
       swap can't remount the card — the key is turnId). */
    await turn.locator(TRIGGER).first().click();
    await expect(turn.locator(PANEL)).toHaveCount(0);
    await turn.locator(TRIGGER).first().click();
    await expect(turn.locator(PANEL)).toBeVisible();

    const staysOpen = (async () => {
      for (;;) {
        const settled = await turn.locator("[data-turnsettled]").count();
        if (settled > 0) return;
        const open = await turn.locator(PANEL).count();
        if (open === 0)
          throw new Error("steps block folded while the turn ran");
        await page.waitForTimeout(150);
      }
    })();
    await allowAllWhile(page, staysOpen);
    await expectSettled(turn);
    // Turn ended — the user-opened block must still be expanded (the live
    // row's id swap may remount the card; the persisted collapse state must
    // survive it either way).
    await expect(turn.locator(PANEL)).toBeVisible();
    await expect(turn.locator("[data-tasksteps]")).toContainText(/\d+ steps?/);
    await page.screenshot({ path: `${SHOTS}/settled-useropen.png` });
  } finally {
    await stack.stop();
  }
});

/* Evidence grid: collapsed-while-running (approval visible) at the three
   PR-bar widths, light + dark. The theme lives in localStorage — flipping it
   needs a reload, which also drops the component's collapse state, so each
   theme leg re-collapses after it re-navigates. */
test("screens: collapsed running block, light + dark, three widths", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const stack = await bootStack("collapse-shots", {
    relay: wport(4665),
    feed: wport(4766),
    web: wport(5348),
  });
  try {
    await dmDefault(stack, page);
    await send(page, "Add a release note to the readme");

    const collapseTurn = async () => {
      const turn = page.locator("[data-agentturn]").last();
      await expect(turn.locator("[data-tasksteps]")).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByText("Approval needed").first()).toBeVisible({
        timeout: 60_000,
      });
      await turn.locator(TRIGGER).first().click();
      await expect(turn.locator(PANEL)).toHaveCount(0);
      return turn;
    };

    const turn = await collapseTurn();
    for (const w of [1288, 900, 1440]) {
      await page.setViewportSize({ width: w, height: 700 });
      await expect(turn.locator(PANEL)).toHaveCount(0);
      await page.screenshot({
        path: `${SHOTS}/collapsed-${w}x700-light.png`,
      });
    }

    await page.evaluate(() => localStorage.setItem("lilos-theme", "dark"));
    await page.reload();
    const darkTurn = await collapseTurn();
    for (const w of [1288, 900, 1440]) {
      await page.setViewportSize({ width: w, height: 700 });
      await expect(darkTurn.locator(PANEL)).toHaveCount(0);
      await page.screenshot({
        path: `${SHOTS}/collapsed-${w}x700-dark.png`,
      });
    }

    // Settled-collapsed at the PR-bar size: flip back to light, reload (drops
    // userSet), re-collapse, then let the parked approval run out.
    await page.evaluate(() => localStorage.setItem("lilos-theme", "light"));
    await page.reload();
    await page.setViewportSize({ width: 1288, height: 700 });
    const lightTurn = await collapseTurn();
    await allowAllWhile(page, expectSettled(lightTurn));
    await expect(lightTurn.locator("[data-tasksteps]")).toContainText(
      /\d+ steps?/,
    );
    await expect(lightTurn.locator(PANEL)).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/settled-1288x700-light.png` });
  } finally {
    await stack.stop();
  }
});
