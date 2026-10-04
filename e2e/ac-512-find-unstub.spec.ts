import { expect, type Locator, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #512 — held (stubbed) turn rows carry no text nodes (#430), so
 * browser find-in-page can't match inside them. A find chord opens a ~10 s
 * window that mounts every held row; the window lapses and rows re-stub.
 *
 * One 60-turn engine-fake thread (ENGINE_FAKE_TICK=2 keeps 60 sends cheap).
 * The window is driven by the `?findUnstubMs=` test hook — the spec never
 * sleeps: stubs returning is polled, not timed.
 */

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(240_000);
  stack = await bootStack("find512", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
    ENGINE_FAKE_TICK: "2",
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

/* First-run → land on Default's DM. `?findUnstubMs=2500` must ride the
   FIRST load — the store reads it once at module eval, so client-side
   route changes keep it. 2.5 s is long enough that slow CI polls can't
   race the lapse, short enough the re-stub leg still lands fast. */
async function dmDefault(page: Page) {
  await page.goto(`${stack.webUrl}/?findUnstubMs=2500`);
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

/** Turn `i`'s card inside `scope` ended (held stubs keep the markers). */
async function waitSettled(scope: Locator, i: number) {
  const turns = scope.locator("[data-agentturn]");
  await expect
    .poll(() => turns.count(), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(i);
  await expect(turns.nth(i - 1).locator("[data-turnsettled]")).toBeAttached({
    timeout: 60_000,
  });
}

test("AC-1: Cmd+F mounts held rows — turn-1 text is in the DOM; the lapse re-bounds it", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await dmDefault(page);

  /* Turn 1 (lands in Focus). The probe phrase sits past the derived
     title's 48-char cap and the llm title's first-clause/8-words rule, so
     the only DOM carriers are the held turn-1 rows themselves. */
  await send(
    page,
    "where does the relay keep session state and how does recovery work? findprobe-alpha-turn1",
  );
  const focus = page.locator("[data-thread]");
  await waitSettled(focus, 1);

  /* The same thread peeked open in the panel — the frame the issue
     profiled. Turns 2..60 run there. */
  await page.goto(page.url().replace(/\/focus.*$/, ""));
  const panel = page.locator("[data-thread-panel]");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  for (let i = 2; i <= 60; i++) {
    await send(page, `status check pass ${i}`);
    await waitSettled(panel, i);
  }

  /* 121 reply rows » TURN_LAZY_AFTER — far-off-screen rows hold as stubs.
     The phrase poll is the proof turn-1's own row held: it exists nowhere
     in the DOM until the row mounts. */
  const stubs = panel.locator("[data-held-stub]");
  await expect
    .poll(() => stubs.count(), { timeout: 30_000 })
    .toBeGreaterThan(0);
  const heldBefore = await stubs.count();
  await expect
    .poll(() => panel.getByText("findprobe-alpha-turn1").count(), {
      timeout: 30_000,
    })
    .toBe(0);

  /* Ctrl+F — the find chord: every held row mounts; the turn-1 phrase is
     DOM text a find-in-page could match. */
  await page.keyboard.press("Control+f");
  await expect.poll(() => stubs.count(), { timeout: 15_000 }).toBe(0);
  await expect(panel.getByText("findprobe-alpha-turn1").first()).toBeAttached({
    timeout: 15_000,
  });
  const nodesOpen = await page.evaluate(
    () => document.querySelectorAll("*").length,
  );

  /* The window lapses (test-hooked to ~2.5 s) → off-screen rows re-stub
     and the DOM re-bounds. */
  await expect
    .poll(() => stubs.count(), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(heldBefore);
  const nodesClosed = await page.evaluate(
    () => document.querySelectorAll("*").length,
  );
  expect(nodesClosed).toBeLessThan(nodesOpen / 2);
});
