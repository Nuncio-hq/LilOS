import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #585 — system notes look like system notes, real app (apps/web over
 * relay + harness on engine-fake). AC-1 notes render as centred
 * `data-sysnote` rows — never Oscar's right-aligned bubble — and drop when
 * the turn beside them already shows the same status; AC-2 a denied
 * approval keeps the turn and its card ("Denied by …"); AC-3 message
 * search labels a system note "LilOS", not Oscar.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-585");

async function openApp(stack: Stack, page: Page) {
  await page.addInitScript(() => localStorage.setItem("lilos-onboarded", "1"));
  await page.goto(`${stack.webUrl}/`);
  await expect(page).toHaveURL(/\/dm\//, { timeout: 30_000 });
  await expect(
    page.locator("aside").getByRole("button", { name: /Default/ }),
  ).toBeVisible({ timeout: 30_000 });
}

const empId = (page: Page) =>
  decodeURIComponent(page.url().split("/dm/")[1].split("/")[0]);

/** Back to the DM home (sends land in Focus); its filter box lives there. */
async function dmHome(stack: Stack, page: Page) {
  await page.goto(`${stack.webUrl}/dm/${empId(page)}`);
  await expect(page.getByPlaceholder(/Filter/)).toBeVisible({
    timeout: 30_000,
  });
}

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

const openCard = (page: Page) =>
  page.locator('[data-ask-id][data-ask-state="open"]');

test.describe.configure({ mode: "serial" });
test.use({ video: "on" });

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac585", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

test("AC-1 a LilOS note renders centred, never as Oscar's bubble", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openApp(stack, page);

  /* Full access → the gated step auto-approves and the harness posts a
     LilOS note ("Auto-approved … — Full access") into the thread. */
  const pill = page.locator('[data-slot="access-pill"]');
  await expect(pill).toBeVisible({ timeout: 30_000 });
  await pill.click();
  await expect(pill).toHaveAttribute("data-access", "full");

  await send(page, "Add a footer to the page");
  const note = page.locator("[data-sysnote]", {
    hasText: /Auto-approved/,
  });
  await expect(note.first()).toBeVisible({ timeout: 60_000 });
  /* The centred note is its own row — it never carries a user or agent
     avatar, and it is not a right-aligned bubble. */
  await expect(note.first().locator("..")).not.toHaveClass(/justify-end/);
  await page.screenshot({ path: `${SHOTS}/ac-1-sysnote.png` });
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 90_000,
  });
});

test("AC-1 a 'Stopped.' note drops beside the stopped turn it repeats", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openApp(stack, page);
  await send(page, "slow: hold this turn while I stop it");
  const stop = page.getByRole("button", { name: "Stop (Esc)" });
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await stop.click();
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 60_000,
  });
  /* The turn shows "Stopped" itself — the bare note is a duplicate and
     never renders. */
  await expect(
    page.locator("[data-sysnote]", { hasText: /^Stopped\.?$/ }),
  ).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-1-stopped-dedupe.png` });
});

test("AC-2 a denied approval keeps the turn and its card", async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(stack, page);
  await send(page, "Change the header color");
  const card = openCard(page).first();
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.getByRole("button", { name: "Deny", exact: true }).click();

  /* The card stays with "Denied" — the engine's silent end never blanks
     the turn out. */
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 90_000,
  });
  const resolved = page.locator('[data-ask-id][data-ask-state="resolved"]', {
    hasText: /Denied/,
  });
  await expect(resolved.first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-2-denied-kept.png` });
});

test('AC-3 message search labels a system note "LilOS"', async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(stack, page);
  /* Make a LilOS note searchable: Full access → "Auto-approved …" posts. */
  const pill = page.locator('[data-slot="access-pill"]');
  await expect(pill).toBeVisible({ timeout: 30_000 });
  await pill.click();
  await send(page, "Add a footer to the page");
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 90_000,
  });

  /* Search inside the DM for the note's own word — the filter box is on
     the DM home; sends land in Focus, so navigate back first. */
  await dmHome(stack, page);
  const filter = page.getByPlaceholder(/Filter/);
  await filter.fill("Auto-approved");
  const hit = page.locator("[data-message-hit]", {
    hasText: /Auto-approved/,
  });
  await expect(hit.first()).toBeVisible({ timeout: 30_000 });
  await expect(hit.first()).toContainText("LilOS");
  await page.screenshot({ path: `${SHOTS}/ac-3-search-lilos.png` });
});
