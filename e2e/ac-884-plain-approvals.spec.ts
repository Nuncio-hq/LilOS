import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  freePort,
  openDefaultAgent,
  type Stack,
  skipFirstRun,
  startChat,
  threadUrl,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * Issue #884 — an approval is one plain question with Allow / Deny, the
 * same everywhere (real app: relay + harness on engine-fake). The card asks
 * "Edit README.md?", never raw tool+args JSON; This thread and Always live
 * under Allow's ▾; Home's needs-you row names the thread; a deny reads
 * "You said no" and is not a failure; Settings shows only Ask / Full
 * access — the engine's Smart / Manual / Off row is gone.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-884");

let stack: Stack;
let agent: { id: string; name: string };
test.beforeAll(async () => {
  test.setTimeout(120_000);
  /* Six workers share the Mac and another run holds this worker's slice —
     a probed free port under the slice floor serves vite instead. And the
     stack boots PAUSED (LILOS_COMPANY=0): that is the real app's view —
     the default LILOS_COMPANY=1 draws the paused company layer instead
     (D-#836). */
  stack = await bootStack(
    "ac884",
    { relay: 0, feed: 0, web: await freePort() },
    { LILOS_COMPANY: "0" },
  );
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.locator("#v3-main");
const openCard = (page: Page) =>
  page.locator('[data-ask-id][data-ask-state="open"]');
const settled = (page: Page) => page.locator("[data-turnsettled]").last();

test("the card asks one plain question; its scopes sit under Allow's menu", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1288, height: 800 });
  agent = await openDefaultAgent(page, stack.webUrl);
  await startChat(page, stack.webUrl, agent, "Add a footer to the page");

  // The thread card: one sentence, two answers — no JSON anywhere.
  const card = openCard(page).first();
  await expect(card).toContainText("Edit README.md?", { timeout: 60_000 });
  await expect(
    card.getByRole("button", { name: "Allow", exact: true }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Deny", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/patch \{/)).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "Once", exact: true }),
  ).toHaveCount(0);

  // The other grant scopes are the ▾ on Allow, not a row of four buttons.
  await card
    .getByRole("button", { name: "More ways to allow", exact: true })
    .click();
  await expect(
    card.getByRole("menuitem", { name: "This thread", exact: true }),
  ).toBeVisible();
  await expect(
    card.getByRole("menuitem", { name: "Always", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-1-card-scopes.png` });
  await page.keyboard.press("Escape");

  // Home's needs-you row: the thread's name, the sentence beside it.
  await v3Sidebar(page).getByRole("button", { name: "Home" }).click();
  const homeAsk = main(page)
    .getByRole("button")
    .filter({ hasText: /add a footer to the page/i })
    .filter({ hasText: /Edit README\.md\?/ });
  await expect(homeAsk).toBeVisible();
  await expect(
    homeAsk.getByRole("button", { name: "Allow", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-1-home-row.png` });

  // Allow straight from Home answers the ask; the turn carries on.
  await homeAsk.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(homeAsk).toHaveCount(0, { timeout: 30_000 });
});

test("a deny reads 'You said no', the turn counts it as an answer, never a failure", async ({
  page,
}) => {
  test.setTimeout(240_000);
  agent = await openDefaultAgent(page, stack.webUrl);
  await startChat(page, stack.webUrl, agent, "Add a footer to the page");
  const card = openCard(page).first();
  await expect(card).toContainText("Edit README.md?", { timeout: 60_000 });

  // Deny every gated step the turn raises (patch, then write_file, then
  // git commit — engine-fake asks before each).
  const deny = (page: Page) =>
    openCard(page).first().getByRole("button", { name: "Deny", exact: true });
  await expect(async () => {
    if (await deny(page).isVisible()) await deny(page).click();
    await expect(settled(page)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 120_000 });

  // The receipts are "You said no" — not "Denied", and nothing failed.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(v3Peek(page).getByText("You said no").first()).toBeVisible();
  await expect(v3Peek(page).getByText(/Denied/)).toHaveCount(0);
  await expect(v3Peek(page).getByText(/\bfailed\b/i)).toHaveCount(0);
  // The work summary says "you said no", never "N failed".
  await expect(
    v3Peek(page)
      .getByText(/you said no/)
      .first(),
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-2-denied.png` });
});

test("Settings keeps Ask / Full access only — no engine policy row", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await skipFirstRun(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${stack.webUrl}/#?page=settings&view=general`);
  const approvals = page.getByRole("radiogroup", {
    name: "Approvals",
    exact: true,
  });
  await expect(approvals).toBeVisible({ timeout: 30_000 });
  await expect(
    approvals.getByRole("radio", { name: "Ask before risky commands" }),
  ).toBeVisible();
  await expect(
    approvals.getByRole("radio", { name: "Full access" }),
  ).toBeVisible();
  await expect(
    page.getByRole("radiogroup", { name: "Engine approval policy" }),
  ).toHaveCount(0);
  for (const name of ["Smart", "Manual", "Off"])
    await expect(page.getByRole("radio", { name, exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-3-settings.png` });
});

/* The issue's before/after evidence: the card, the Home row and Settings in
   light and dark (before: /tmp/lilos-ux/08-*.png, 26-*.png, 29/30-*-dark). */
test("after shots — card, Home row and Settings in light and dark", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1288, height: 800 });
  agent = await openDefaultAgent(page, stack.webUrl);
  const html = page.locator("html");
  for (const scheme of ["light", "dark"] as const) {
    /* Reduced motion makes each shot a settled frame — lilos-rise keeps a
       freshly-routed page at opacity 0 until the animation plays out. */
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.goto(`${stack.webUrl}/#?page=settings&view=general`);
    await expect(
      page.getByRole("radiogroup", { name: "Approvals", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await page.screenshot({
      path: `${SHOTS}/after-settings-${scheme}.png`,
      fullPage: true,
    });
    const convId = await startChat(
      page,
      stack.webUrl,
      agent,
      "Add a footer to the page",
    );
    const card = openCard(page).first();
    await expect(card).toContainText("Edit README.md?", {
      timeout: 60_000,
    });
    if (scheme === "dark") {
      await expect(html).toHaveClass(/dark/);
    } else {
      await expect(html).not.toHaveClass(/dark/);
    }
    await page.screenshot({
      path: `${SHOTS}/after-card-${scheme}.png`,
      fullPage: true,
    });
    await v3Sidebar(page).getByRole("button", { name: "Home" }).click();
    await expect(
      main(page)
        .getByRole("button")
        .filter({ hasText: /add a footer to the page/i })
        .filter({ hasText: /Edit README\.md\?/ })
        .first(),
    ).toBeVisible({ timeout: 30_000 });
    await page.screenshot({
      path: `${SHOTS}/after-home-${scheme}.png`,
      fullPage: true,
    });
    /* The company layer's Home has its own needs row (NeedsBlock); the
       ?company=1 search flag draws it on this same paused stack. */
    await page.goto(`${stack.webUrl}/?company=1#?page=home`);
    await expect(
      main(page)
        .getByRole("button")
        .filter({ hasText: /add a footer to the page/i })
        .filter({ hasText: /Edit README\.md\?/ })
        .first(),
    ).toBeVisible({ timeout: 30_000 });
    await page.screenshot({
      path: `${SHOTS}/after-home-company-${scheme}.png`,
      fullPage: true,
    });
    /* Resolve the open asks so the next scheme's turn starts clean — the
       sidebar nav closed the peek (D-#769), so the thread is re-opened and
       each gated step denied until the turn ends. */
    await page.goto(threadUrl(stack.webUrl, convId));
    const deny = openCard(page)
      .first()
      .getByRole("button", { name: "Deny", exact: true });
    await expect(async () => {
      if (await deny.isVisible()) await deny.click();
      await expect(settled(page)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 120_000 });
  }
});
