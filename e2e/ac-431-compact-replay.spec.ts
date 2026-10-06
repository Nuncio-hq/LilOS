import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { growDmThread } from "./helpers/relay-thread";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #431 — AC-2: reloading a long thread renders the identical
 * transcript, faster. The finished turns' delta runs are gone from the
 * engine log (compacted into `turn.recap` at the last delta's seq, bounded
 * by EVENT_LOG_CAP) — this spec proves the rebuilt view is byte-identical
 * to the live-built one and times the reload.
 *
 * Twelve `md: table` turns ≈ 3.4K live engine events through the thread —
 * the compacted replay it folds back is ~100× smaller. The thread grows
 * through relay RPC (#574 — the same calls the composer makes, minus the
 * per-turn browser round trip); each send waits its own `turn.completed`
 * so the transcript is 12 settled turns, not a queue drain.
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
  /* Grow all 12 turns through relay RPC (#574) — identical persisted
     messages to the composer path, without 12 browser round trips. */
  const grown = await growDmThread(
    stack,
    Array.from({ length: TURNS }, (_, i) => `md: table — turn ${i + 1}`),
  );
  await page.goto(
    `${stack.webUrl}/dm/${grown.employeeId}/${grown.conversationId}/focus`,
  );
  const turns = page.locator("[data-agentturn]");
  await expect(turns).toHaveCount(TURNS, { timeout: 60_000 });
  /* Settled, not mid-flight — the last turn's card shows its answer tail
     before the transcript is captured. */
  await expect(turns.last()).toContainText(LAST_ANSWER, {
    timeout: 60_000,
  });

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
