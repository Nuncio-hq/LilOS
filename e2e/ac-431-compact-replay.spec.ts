import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #431 — AC-2: reloading a long thread renders the identical
 * transcript, faster. The finished turns' delta runs are gone from the
 * engine log (compacted into `turn.recap` at the last delta's seq, bounded
 * by EVENT_LOG_CAP) — this spec proves the rebuilt view is byte-identical
 * to the live-built one and times the reload.
 *
 * Twelve `md: table` turns ≈ 3.4K live engine events through the thread —
 * the compacted replay it folds back is ~100× smaller. Sequential sends
 * wait for each turn's card so the transcript is 12 settled turns, not a
 * queue drain.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-431");
const TURNS = 12;
/* The tail of the markdown-table sample — the last turn's answer proves
   the replayed stream reached the end. */
const LAST_ANSWER = "Everything outside the tables renders as normal prose.";

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(180_000);
  stack = await bootStack("replay", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
    ENGINE_FAKE_TICK: "2",
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

/* Row headers carry absolute `HH:MM` stamps — identical content can straddle
   a minute boundary between build and reload, so the compare normalizes
   them; everything else is transcript text. */
const mainText = async (page: Page) =>
  (await page.locator("[data-thread]").innerText()).replace(
    /\b\d{1,2}:\d{2}\b/g,
    "@",
  );

test("AC-2 reload of a long thread renders the identical transcript, faster", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await dmDefault(page);
  const turns = page.locator("[data-agentturn]");
  for (let i = 1; i <= TURNS; i++) {
    await send(page, `md: table — turn ${i}`);
    await expect(turns).toHaveCount(i, { timeout: 60_000 });
    /* Settle before the next send — a mid-turn send would steer into the
       running turn instead of minting the next one. */
    await expect(turns.last()).toContainText(LAST_ANSWER, {
      timeout: 60_000,
    });
  }

  const before = await mainText(page);
  await page
    .locator("[data-thread]")
    .screenshot({ path: `${SHOTS}/before-reload.png` });

  const t0 = Date.now();
  await page.reload();
  /* Converged = the rebuilt transcript is byte-identical to the one the
     live deltas painted — poll, since the fold replays then settles. */
  await expect
    .poll(async () => mainText(page), { timeout: 60_000 })
    .toBe(before);
  const reloadMs = Date.now() - t0;
  await page
    .locator("[data-thread]")
    .screenshot({ path: `${SHOTS}/after-reload.png` });

  /* The turn cards rebuilt from recaps carry the same answers — spot-check
     the first and last. */
  await expect(turns).toHaveCount(TURNS);
  await expect(turns.first()).toContainText(LAST_ANSWER);
  await expect(turns.last()).toContainText(LAST_ANSWER);
  console.log(
    `[ac-431] reload→identical transcript: ${reloadMs}ms (turns=${TURNS})`,
  );
  test.info().annotations.push({
    type: "ac-431-reload-ms",
    description: `${reloadMs}`,
  });
});
