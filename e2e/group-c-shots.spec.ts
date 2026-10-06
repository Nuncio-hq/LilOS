import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Group C screenshot harvest — NOT an AC suite. Drives the app through the
 * states #583/#585/#586/#588/#589/#582 ship, and captures the PR evidence at
 * 1288x700, 1288x900 and 1440x900 in light and dark. Output goes to
 * pr-assets/group-c/<issue>/ for the PR body.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const OUT = path.join(repo, "shots", "group-c");
const shot = (page: Page, issue: string, name: string, theme: string) =>
  page.screenshot({ path: path.join(OUT, issue, `${name}-${theme}.png`) });

const S1288x700 = { width: 1288, height: 700 };
const S1288x900 = { width: 1288, height: 900 };
const S1440x900 = { width: 1440, height: 900 };

const empId = (page: Page) =>
  decodeURIComponent(page.url().split("/dm/")[1].split("/")[0]);
const dmHome = async (stack: Stack, page: Page) => {
  await page.goto(`${stack.webUrl}/dm/${empId(page)}`);
  await expect(page.getByPlaceholder(/Filter/)).toBeVisible({
    timeout: 30_000,
  });
};
const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};
const openCard = (page: Page) =>
  page.locator('[data-ask-id][data-ask-state="open"]');
const settled = (page: Page) => page.locator("[data-turnsettled]").last();

/* The access pill toggles ask↔full through a relay round-trip; click until
   the attribute lands. */
async function setAccess(page: Page, want: "ask" | "full") {
  const pill = page.locator('[data-slot="access-pill"]');
  await expect(pill).toBeVisible({ timeout: 30_000 });
  for (let i = 0; i < 4; i++) {
    if ((await pill.getAttribute("data-access")) === want) return;
    await pill.click();
    await page.waitForTimeout(500);
  }
  await expect(pill).toHaveAttribute("data-access", want, {
    timeout: 15_000,
  });
}

test.describe.configure({ mode: "serial" });

for (const theme of ["light", "dark"] as const) {
  test(`group-c surfaces — ${theme}`, async ({ page }) => {
    test.setTimeout(420_000);
    const stack: Stack = await bootStack(
      `shotc-${theme[0]}`,
      await pickPorts(),
    );
    try {
      await page.setViewportSize(S1288x900);
      await page.addInitScript((t) => {
        localStorage.setItem("lilos-onboarded", "1");
        localStorage.setItem("lilos-theme", t);
      }, theme);
      await page.goto(`${stack.webUrl}/`);
      await expect(page).toHaveURL(/\/dm\//, { timeout: 30_000 });
      await expect(
        page.locator("aside").getByRole("button", { name: /Default/ }),
      ).toBeVisible({ timeout: 30_000 });
      if (theme === "dark") {
        await expect(page.locator("html")).toHaveClass(/dark/);
      } else {
        await expect(page.locator("html")).not.toHaveClass(/dark/);
      }

      /* #586 — the idle placeholder names the employee, never an id. */
      await page.setViewportSize(S1288x700);
      await shot(page, "586", "placeholder-idle", theme);
      await page.setViewportSize(S1288x900);

      /* #583 needs-you row: leave the ask open. */
      await send(page, "Add a footer to the page");
      await expect(openCard(page).first()).toBeVisible({ timeout: 60_000 });
      /* waiting composer — same surface names the reason. */
      await page.setViewportSize(S1440x900);
      await shot(page, "583", "composer-waiting", theme);
      await page.setViewportSize(S1288x900);
      await shot(page, "583", "composer-waiting-1288", theme);
      await dmHome(stack, page);

      /* #583 running row. */
      await send(page, "slow:400 a long running turn for the shot");
      await expect(page.locator("[data-agentturn]").last()).toBeVisible({
        timeout: 30_000,
      });
      await dmHome(stack, page);

      /* #583 failed row. */
      await send(page, "fail on purpose");
      await expect(page.locator("[data-turn-failed]").last()).toBeVisible({
        timeout: 90_000,
      });
      await dmHome(stack, page);

      /* #583 stopped row: a slow turn we interrupt. */
      await send(page, "slow:300 hold this turn for the stop shot");
      const stop = page.getByRole("button", { name: "Stop (Esc)" });
      await expect(stop).toBeVisible({ timeout: 30_000 });
      await stop.click();
      await expect(settled(page)).toBeVisible({ timeout: 60_000 });
      await dmHome(stack, page);

      /* #583 background job row. */
      await send(page, "start a dev server");
      await expect(settled(page)).toBeVisible({ timeout: 90_000 });
      await dmHome(stack, page);

      /* The DM home now shows every state at once. */
      await expect(
        page.locator('[data-thread-state="needs you"]').first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.locator('[data-thread-state="failed"]').first(),
      ).toBeVisible();
      await expect(
        page.locator('[data-thread-state="stopped"]').first(),
      ).toBeVisible();
      await expect(page.locator("[data-bg-jobs]").first()).toBeVisible();
      await shot(page, "583", "rows-all-states-1288x900", theme);
      await page.setViewportSize(S1288x700);
      await shot(page, "583", "rows-all-states-1288x700", theme);
      await page.setViewportSize(S1440x900);
      await shot(page, "583", "rows-all-states-1440x900", theme);
      await page.setViewportSize(S1288x900);

      /* #583 AC-3 — open the job's thread: the header says running in
         background. */
      const jobRow = page
        .locator("[data-session]", { has: page.locator("[data-bg-jobs]") })
        .last();
      await jobRow.locator("button").last().click();
      await expect(
        page
          .locator("[data-bg-jobs]")
          .filter({ hasText: /running in background/ }),
      ).toBeVisible({ timeout: 30_000 });
      await shot(page, "583", "thread-bg-jobs", theme);
      await dmHome(stack, page);

      /* #585 centred system note: Full access → Auto-approved posts. */
      await setAccess(page, "full");
      await send(page, "Add a footer to the page");
      const sysnote = page
        .locator("[data-sysnote]", { hasText: /Auto-approved/ })
        .first();
      await expect(sysnote).toBeVisible({ timeout: 60_000 });
      await sysnote.scrollIntoViewIfNeeded();
      await shot(page, "585", "sysnote-auto-approved-1288x900", theme);
      await page.setViewportSize(S1288x700);
      await sysnote.scrollIntoViewIfNeeded();
      await shot(page, "585", "sysnote-auto-approved-1288x700", theme);
      await page.setViewportSize(S1288x900);
      await expect(settled(page)).toBeVisible({ timeout: 90_000 });

      /* #585 denied approval keeps turn + card. Back to Ask first. */
      await dmHome(stack, page);
      await setAccess(page, "ask");
      await send(page, "Change the header color");
      const denyCard = openCard(page).first();
      await expect(denyCard).toBeVisible({ timeout: 60_000 });
      await denyCard.getByRole("button", { name: "Deny", exact: true }).click();
      /* The turn must have settled and the resolved card be on screen —
         the row is virtualized, so pull it into view before shooting. */
      await expect(settled(page)).toBeVisible({ timeout: 90_000 });
      const resolved = page
        .locator('[data-ask-id][data-ask-state="resolved"]', {
          hasText: /Denied/,
        })
        .first();
      await expect(resolved).toBeVisible({ timeout: 30_000 });
      await resolved.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await shot(page, "585", "denied-card-kept-1288x900", theme);
      await page.setViewportSize(S1288x700);
      await resolved.scrollIntoViewIfNeeded();
      await shot(page, "585", "denied-card-kept-1288x700", theme);
      await page.setViewportSize(S1288x900);
      await dmHome(stack, page);

      /* #588 — Hire dialog. */
      await page
        .locator("aside")
        .getByRole("button", { name: /Hire employee/ })
        .click();
      const hire = page
        .locator("div.fixed.inset-0")
        .filter({ hasText: "Hire an employee" })
        .last();
      await expect(hire.getByText("Hire an employee")).toBeVisible({
        timeout: 15_000,
      });
      await page.setViewportSize(S1440x900);
      await shot(page, "588", "hire-dialog", theme);
      /* Custom-div dialog: Escape does nothing — its Cancel closes it. */
      await hire.getByRole("button", { name: "Cancel" }).click();
      await expect(hire).toHaveCount(0);
      await page.setViewportSize(S1288x900);

      /* #588 — employee card → Edit employee → Remove confirm. */
      await page.getByRole("button", { name: "Profile", exact: true }).click();
      const profileCard = page
        .getByRole("dialog", { name: /profile/i })
        .first();
      await expect(profileCard).toBeVisible({ timeout: 15_000 });
      await profileCard
        .getByRole("button", { name: /^Edit$/ })
        .first()
        .click();
      const edit = page
        .locator("div.fixed.inset-0")
        .filter({ hasText: "Edit employee" })
        .last();
      await expect(
        page.getByText("Edit employee", { exact: true }),
      ).toBeVisible({ timeout: 15_000 });
      await shot(page, "588", "edit-employee", theme);
      await edit.getByRole("button", { name: /remove from company/i }).click();
      await expect(
        page.getByText(/Remove Default from the company\?/),
      ).toBeVisible({ timeout: 15_000 });
      await page.setViewportSize(S1288x700);
      await shot(page, "588", "remove-confirm", theme);
      await page.setViewportSize(S1288x900);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");

      /* #589 — first-run success (fresh, non-onboarded context on the same
         healthy stack). */
      const browser = page.context().browser();
      if (!browser) throw new Error("no browser");
      const fresh = await browser.newContext({
        viewport: S1288x900,
      });
      await fresh.addInitScript(
        (t) => localStorage.setItem("lilos-theme", t),
        theme,
      );
      const fpage = await fresh.newPage();
      await fpage.goto(`${stack.webUrl}/?statusPollMs=500`);
      await expect(
        fpage.locator("[data-first-run-step]").nth(0),
      ).toHaveAttribute("data-state", "ok", { timeout: 30_000 });
      await expect(
        fpage.locator("[data-first-run-step]").nth(1),
      ).toHaveAttribute("data-state", "ok", { timeout: 60_000 });
      await fpage.screenshot({
        path: path.join(OUT, "589", `first-run-ok-1288x900-${theme}.png`),
      });
      await fpage.setViewportSize(S1440x900);
      await fpage.screenshot({
        path: path.join(OUT, "589", `first-run-ok-1440x900-${theme}.png`),
      });
      await fresh.close();
    } finally {
      await stack.stop();
    }
  });
}

/* #589 dead engine: first-run failure leg with the plain reason + See
   status. One shot per theme, at the two smaller sizes. */
for (const theme of ["light", "dark"] as const) {
  test(`first-run failure — ${theme}`, async ({ page }) => {
    test.setTimeout(180_000);
    const stack: Stack = await bootStack(
      `shotc-d${theme[0]}`,
      await pickPorts(),
      {
        LILOS_ENGINE: "hermes",
        HERMES_BIN: "/nonexistent/hermes-bin",
      },
    );
    try {
      await page.setViewportSize(S1288x900);
      await page.addInitScript(
        (t) => localStorage.setItem("lilos-theme", t),
        theme,
      );
      await page.goto(`${stack.webUrl}/?statusPollMs=500`);
      const leg = page.locator("[data-first-run-step]").nth(1);
      await expect(leg).toHaveAttribute("data-state", "failed", {
        timeout: 90_000,
      });
      await expect(
        leg.getByRole("button", { name: "See status" }),
      ).toBeVisible();
      await page.screenshot({
        path: path.join(OUT, "589", `first-run-failed-1288x900-${theme}.png`),
      });
      await page.setViewportSize(S1288x700);
      await page.screenshot({
        path: path.join(OUT, "589", `first-run-failed-1288x700-${theme}.png`),
      });
      /* "See status" opens the System status dialog. */
      await page.setViewportSize(S1288x900);
      await leg.getByRole("button", { name: "See status" }).click();
      await expect(
        page.getByRole("dialog", { name: /status/i }).first(),
      ).toBeVisible({ timeout: 15_000 });
      await page.screenshot({
        path: path.join(OUT, "589", `see-status-${theme}.png`),
      });
    } finally {
      await stack.stop();
    }
  });
}
