import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { electronScreenshot, launchDesktop } from "./helpers/electron";
import {
  bootStack,
  pickPorts,
  type Stack,
  skipFirstRun,
  startChat,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * Issue #71 — desktop DM polish (incl. the AC-7 model-display-name scope
 * add from the issue comments). Each acceptance criterion is a named test
 * against the real stack (apps/relay + apps/harness on engine-fake + vite
 * dev, Electron for AC-5), same harness as e2e/ac-27-dm.spec.ts on offset
 * ports.
 *
 * v3: a chat starts from the new-chat draft beside Threads and its thread
 * opens in the side peek (`[data-thread-panel]`). The old per-session DM
 * list row is the Threads board card for the thread, and the sidebar's
 * per-employee badge is the person's status dot plus the "Needs you" count.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
// --repeat-each spreads a file's repeats across worker processes; each boots
// the stack again, so ports are offset per worker or relays race one port (#84).

const SHOTS = path.join(repo, "test-results", "ac-71");

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac71", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

const AGENT = { id: "default", name: "Default" };

/** A new chat with the seeded Default employee: the draft beside Threads,
    then the thread in the side peek. Past first run. */
async function chatDefault(page: Page, text: string) {
  await skipFirstRun(page);
  await startChat(page, stack.webUrl, AGENT, text);
}

/** The default agent's dot in the sidebar: the per-employee badge. */
const agentDot = (page: Page, status: string) =>
  v3Sidebar(page)
    .getByRole("button", { name: /default/i })
    .locator(`[data-v3-status="${status}"]`);

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
  await chatDefault(page, "Say hello then list files");
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
  await chatDefault(page, "Say hello then list files");
  // #224 orb design: an employee avatar is a tone-shifted colour orb
  // (role=img + the name as its label), not a file <img>. v3 draws it on the
  // employee's turn in the thread; the shell's own chrome (sidebar, Threads
  // cards, People) uses the letter chip instead, so the orb is asserted where
  // it lives. The broken-image check still guards any <img> the page renders.
  const orbs = page.locator(
    '[data-thread-panel] [role="img"]:has(.lilos-orb-blobs)',
  );
  await expect(orbs.first()).toBeVisible({ timeout: 30_000 });
  await expect(orbs.first()).toHaveAttribute("aria-label", AGENT.name);
  expect(await brokenImages(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/ac-2-avatars.png` });
});

test("AC-3 the thread header hides `· now:` when the employee has none", async ({
  page,
}) => {
  await chatDefault(page, "Say hello then list files");
  const peek = v3Peek(page);
  /* The peek's trail names the employee ("Default · Chat"); the header under
     it carries only what the trail lacks — the thread's own quiet line (the
     folder link) — and never repeats the agent (#770). */
  await expect(peek.getByRole("navigation", { name: "Trail" })).toContainText(
    `${AGENT.name} · Chat`,
    { timeout: 30_000 },
  );
  const subtitle = page.locator("[data-thread-panel] [title^='Thread ']");
  await expect(subtitle).toBeVisible({ timeout: 30_000 });
  // The employee has no `now:` — nothing in the header may claim one.
  await expect(subtitle).not.toContainText("now:");
  await expect(peek.locator("[data-thread-header]")).not.toContainText("now:");
  await page.screenshot({ path: `${SHOTS}/ac-3-header.png` });
});

test("AC-4 an approval-blocked session reads `needs you` / `Waiting for approval`", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await chatDefault(page, "Add a release note to the readme");
  await expect(page.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });
  // The blocked tool card inside the turn.
  await expect(
    page.locator("[data-tasksteps]").getByText("Waiting for approval"),
  ).toBeVisible({ timeout: 30_000 });
  // The employee's badge (the status dot goes `needs`, the sidebar's "Needs
  // you" count says one) and the thread's Threads-board card both read
  // `Needs you`.
  await expect(agentDot(page, "needs")).toBeVisible({ timeout: 60_000 });
  await expect(
    v3Sidebar(page).getByRole("button", { name: /Needs you/ }),
  ).toContainText("1");
  // Leave the session (close the peek): the board card is the list row.
  await v3Peek(page).getByTitle("Close (Esc)").click();
  await expect(v3Peek(page)).toHaveCount(0);
  const waitingCard = page
    .locator("#v3-main")
    .getByRole("button")
    .filter({ hasText: /release note/i });
  await expect(waitingCard).toContainText("Needs you", { timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-4-needs-you.png` });
  // Back in the session, answering the approval unblocks the turn.
  await waitingCard
    .getByText(/release note/i)
    .first()
    .click();
  await expect(page).toHaveURL(/open=thread:[^&]+$/);
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
  // The picker lives in the session thread — open a session first.
  await chatDefault(page, "Say hello then list files");
  const turn = page.locator("[data-agentturn]").first();
  await expect(turn).toBeVisible({ timeout: 30_000 });
  // A finished turn's footer names the model, same label as the picker.
  await expect(turn).toContainText("Fake Large", { timeout: 60_000 });
  await expect(turn).not.toContainText("· Fake Large");
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
  const { app, win } = await launchDesktop(stack);
  try {
    expect(await app.evaluate(({ app }) => app.getName())).toBe("LilOS");
    await expect(
      v3Sidebar(win).getByRole("button", { name: /default/i }),
    ).toBeVisible({ timeout: 60_000 });
    // captureScreenshot fails if the window hasn't painted yet — wait for
    // visible+painted and retry.
    await electronScreenshot(app, win, `${SHOTS}/ac-5-electron.png`);
  } finally {
    await app.close();
  }
});
