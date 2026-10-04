import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, expect, type Page, test } from "@playwright/test";
import { electronScreenshot, ensureDesktopPayload } from "./helpers/electron";
import { bootStack, type Stack } from "./helpers/stack";
import { wport } from "./ports";

/**
 * Issue #71 — desktop DM polish (incl. the AC-7 model-display-name scope
 * add from the issue comments). Each acceptance criterion is a named test
 * against the real stack (apps/relay + apps/harness on engine-fake + vite
 * dev, Electron for AC-5), same harness as e2e/ac-27-dm.spec.ts on offset
 * ports.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
// --repeat-each spreads a file's repeats across worker processes; each boots
// the stack again, so ports are offset per worker or relays race one port (#84).

const desktopDir = path.join(repo, "apps", "desktop");

const SHOTS = path.join(repo, "test-results", "ac-71");

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac71", {
    relay: wport(4656),
    feed: wport(4657),
    web: wport(5258),
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

async function dmDefault(page: Page) {
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

const employeeIdFromUrl = (page: Page) =>
  decodeURIComponent(page.url().split("/dm/")[1].split("/")[0]);

/** Counts <img> elements that failed to load (broken images). */
const brokenImages = (page: Page) =>
  page
    .locator("img")
    .evaluateAll((imgs) =>
      imgs
        .filter((i) => !(i.complete && i.naturalWidth > 0))
        .map((i) => i.getAttribute("src")),
    );

test("AC-1 tool events render once — as the tool cards inside the turn", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  await send(page, "Say hello then list files");
  const turn = page.locator("[data-agentturn]").first();
  await expect(turn).toBeVisible({ timeout: 30_000 });
  await expect(turn.locator("[data-tasksteps]")).toBeVisible({
    timeout: 60_000,
  });
  await expect(turn).toContainText(/envelope|file|Done|answer/i, {
    timeout: 60_000,
  });
  // No raw `⚙` system rows (the collapsed duplicates) anywhere on the page.
  await expect(page.getByText(/⚙/)).toHaveCount(0);
  // The tool steps live in ONE collapsed block inside the turn.
  await expect(turn.locator("[data-tasksteps]")).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/ac-1-tool-cards.png` });
});

test("AC-2 employee avatars render as colour orbs; no image on the page is broken", async ({
  page,
}) => {
  await dmDefault(page);
  // #224 orb design: an employee avatar is a tone-shifted colour orb
  // (role=img + the name as its label), not a file <img>. The broken-image
  // check still guards any <img> the page does render (human avatars).
  const orbs = page.locator('[role="img"]:has(.lilos-orb-blobs)');
  await expect(orbs.first()).toBeVisible({ timeout: 30_000 });
  expect(await brokenImages(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/ac-2-avatars.png` });
});

test("AC-3 the DM header hides `· now:` when the employee has none", async ({
  page,
}) => {
  await dmDefault(page);
  const subtitle = page.locator("main header .text-xs").first();
  await expect(subtitle).toBeVisible({ timeout: 30_000 });
  await expect(subtitle).not.toContainText("now:");
  await page.screenshot({ path: `${SHOTS}/ac-3-header.png` });
});

test("AC-4 an approval-blocked session reads `needs you` / `Waiting for approval`", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await dmDefault(page);
  const empId = employeeIdFromUrl(page);
  await send(page, "Add a release note to the readme");
  await expect(page.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });
  // The blocked tool card inside the turn.
  await expect(
    page.locator("[data-tasksteps]").getByText("Waiting for approval"),
  ).toBeVisible({ timeout: 30_000 });
  // Sidebar badge + DM list row both read `needs you`.
  await expect(page.locator("[data-badge-approvals]").first()).toContainText(
    "needs you",
  );
  await page.goto(`${stack.webUrl}/dm/${empId}`);
  const waitingRow = page
    .locator("[data-session]")
    .filter({ hasText: /release note/i });
  await expect(waitingRow).toContainText("needs you", { timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-4-needs-you.png` });
  // Back in the session, answering the approval unblocks the turn.
  await waitingRow.getByRole("button", { name: /repl(y|ies)/ }).click();
  await expect(page.getByText("Approval needed").first()).toBeVisible({
    timeout: 30_000,
  });
  const firstAskId = await page
    .locator('[data-ask-state="open"]')
    .first()
    .getAttribute("data-ask-id");
  await page.getByRole("button", { name: "Once", exact: true }).first().click();
  // The fake's script has more approval-gated steps (patch → write_file →
  // git commit): `request.opened(r2)` re-adds "Waiting for approval" ~one
  // engine tick after `request.resolved(r1)` lands, so a zero count — or a
  // resolved card — is a race window, not a state (issue #148). The stable
  // end-state is a NEW open ask with a different id: the engine cannot emit
  // r2's `request.opened` until r1's approval resolved, so its card proves
  // the answer unblocked the turn.
  await expect(
    page.locator(`[data-ask-state="open"]:not([data-ask-id="${firstAskId}"])`),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator("[data-tasksteps]").getByText("Waiting for approval"),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-4-resolved.png` });
});

test("AC-7 model display names — picker groups and the turn footer", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  // The picker lives in the session thread — open a session first.
  await send(page, "Say hello then list files");
  const turn = page.locator("[data-agentturn]").first();
  await expect(turn).toBeVisible({ timeout: 30_000 });
  // A finished turn's footer names the model, same label as the picker.
  await expect(turn).toContainText("· Fake Large", { timeout: 60_000 });
  await expect(turn).not.toContainText("fake-large");
  // Thread-composer picker: provider group headings are display names, not slugs.
  const trigger = page
    .locator('[data-slot="model-picker-trigger"]', {
      hasText: /Fake Large|Fake Small/,
    })
    .last();
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();
  // Picker v2: the popover's "Model ›" row drills into the grouped list.
  await page.getByRole("button", { name: /Model$/ }).click();
  // #194: the heading carries the provider's display name + count; the
  // session's own provider (fake) starts expanded.
  const fake = page.locator("[cmdk-group-heading]", { hasText: "Fake" });
  await expect(fake).toBeVisible();
  await expect(fake).toContainText("Fake");
  await expect(
    page.locator("[cmdk-item]", { hasText: "Fake Small" }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "fake", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${SHOTS}/ac-7-model-names.png` });
});

test("AC-5 the Electron app menu is named LilOS", async () => {
  test.setTimeout(180_000);
  await ensureDesktopPayload(desktopDir);
  const portOf = (ws: string) => new URL(ws).port;
  const app = await _electron.launch({
    args:
      process.platform === "linux"
        ? [desktopDir, "--no-sandbox"]
        : [desktopDir],
    env: {
      ...process.env,
      LILOS_RELAY_HOME: stack.home,
      LILOS_RELAY_PORT: portOf(stack.relayWs),
      LILOS_FEED_PORT: portOf(stack.feedWs),
      LILOS_WEB_URL: stack.webUrl,
    },
  });
  try {
    expect(await app.evaluate(({ app }) => app.getName())).toBe("LilOS");
    const win = await app.firstWindow();
    await expect(
      win.locator("aside").getByRole("button", { name: /default/i }),
    ).toBeVisible({ timeout: 60_000 });
    // captureScreenshot fails if the window hasn't painted yet — wait for
    // visible+painted and retry.
    await electronScreenshot(app, win, `${SHOTS}/ac-5-electron.png`);
  } finally {
    await app.close();
  }
});
