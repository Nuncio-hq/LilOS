import { expect, type Page, test } from "@playwright/test";

/* Issue #12 flow coverage for the extracted @lilos/ui components (text/role assertions only — no pixel
   snapshots, so this stays stable on CI Linux). Proves the extraction did not break behavior:
   DM send → streamed reply · channel @mention → thread + reply · steer (Oscar steers → Oscar steered)
   · stop → not-sent tray · approval card buttons. The fake engine takes ~6-9s per turn, hence the long
   waits. Console errors must be 0 everywhere. */

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

async function sendDM(page: Page, text: string) {
  // The employee row in the sidebar; its accessible name starts with the Hermes avatar alt text.
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /Builder/ })
    .click();
  const box = page.getByPlaceholder(/New session with Builder/);
  await box.fill(text);
  await box.press("Enter");
}

test("DM: sending a message streams an employee reply", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  await page.goto("/");
  await sendDM(page, "What's the state of the relay package?");
  // The engine streams word by word; the last line of the canned reply lands only when the turn is
  // done. Exact match: the same sentence also exists in a muted "latest session" preview.
  await expect(
    page.getByText("Typecheck is clean across 4 packages.", { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  expect(errors).toEqual([]);
});

test("Channel: @mention opens a thread and the employee replies", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  await page.goto("/");
  const box = page.getByPlaceholder(/Message #engineering/);
  await box.fill("@Builder walk me through the envelope contract");
  await box.press("Enter");
  // A thread chip appears in the feed AND the thread panel auto-opens with the reply.
  await expect(
    page.getByText("walk me through the envelope contract").first(),
  ).toBeVisible();
  await expect(
    page.getByText("Typecheck is clean across 4 packages"),
  ).toBeVisible({ timeout: 60_000 });
  expect(errors).toEqual([]);
});

test("Steer mid-turn: waits in the tray, then lands in the turn as 'Oscar steered'", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  await page.goto("/");
  await sendDM(page, "Check the relay reconnect plan");
  // Composer switches to the running/steer state; send a steer there.
  const steer = page.getByPlaceholder(/is working\. Enter steers this turn/);
  await expect(steer).toBeVisible({ timeout: 15_000 });
  await steer.fill("also check the replay window");
  await steer.press("Enter");
  // Not read yet: it waits above the composer, never inside the turn.
  const tray = page.locator('[data-queued][data-queued-mode="steer"]');
  await expect(tray).toContainText("also check the replay window");
  // Delivered at the next tool boundary inside the same turn; the tray empties.
  await expect(page.locator('[data-steerstate="landed"]')).toBeVisible({
    timeout: 30_000,
  });
  await expect(tray).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Stop mid-turn: undelivered steer waits in the not-sent tray", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  await page.goto("/");
  await sendDM(page, "Summarise the harness reconnect notes");
  const steer = page.getByPlaceholder(/is working\. Enter steers this turn/);
  await expect(steer).toBeVisible({ timeout: 15_000 });
  await steer.fill("hold on, do not open a PR yet");
  await steer.press("Enter");
  await expect(page.locator("[data-queued]")).toBeVisible();
  // ■ before the steer hits a tool boundary → it must NOT be lost: it goes to the tray.
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator("[data-notsent]")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-notsent]")).toContainText(
    "not sent · turn stopped",
  );
  expect(errors).toEqual([]);
});

test("Approval card: Allow once resolves the confirmation in the thread", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors = watchConsole(page);
  await page.goto("/");
  // The seeded #engineering thread m1 has an approval card (Reviewer asked to run checks).
  await page.getByText("4 replies").first().click();
  const panel = page.locator("aside").last();
  await expect(
    panel.getByText("Approval needed · only Oscar can answer"),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Once", exact: true }).click();
  await expect(panel.getByText("Allowed once by Oscar")).toBeVisible();
  expect(errors).toEqual([]);
});

/* ---- Issue #15 ---- */

/* Run the stop-with-undelivered-steer flow in the thread panel of #engineering's seeded m2 thread
   (long content → the conversation is definitely scrollable, which is the condition that broke). */
async function stopWithTrayInPanel(page: Page) {
  await page.goto("/");
  // m2 is open by default on wide screens; make sure the panel shows the thread tab.
  const panel = page.locator("aside").last();
  const box = panel.getByPlaceholder(/Reply to/);
  await box.fill("walk me through the envelope again");
  await box.press("Enter");
  const steer = panel.getByPlaceholder(/is working\. Enter steers this turn/);
  await expect(steer).toBeVisible({ timeout: 15_000 });
  await steer.fill("keep it short");
  await steer.press("Enter");
  await expect(panel.locator("[data-queued]").first()).toBeVisible();
  await panel.getByRole("button", { name: "Stop" }).click();
  await expect(panel.locator("[data-notsent]")).toBeVisible({
    timeout: 10_000,
  });
  return panel;
}

/* After ■ the stopped turn AND the not-sent tray must BOTH be fully visible without scrolling: the
   stopped pill sits inside the stick-to-bottom scroll area, the tray grows the composer area below
   it. Root cause was the tray shrinking the scroll viewport without the conversation re-sticking. */
test("Issue #15: stop+tray — the stopped turn and the tray are both fully visible", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = watchConsole(page);
  const panel = await stopWithTrayInPanel(page);

  const stopped = panel.getByText("Stopped · session.interrupt").last();
  await expect(stopped).toBeVisible();

  // The scroll container is the div use-stick-to-bottom scrolls (child of [role=log]).
  const geometry = () =>
    page.evaluate(() => {
      const logParent = document.querySelector("aside [role=log]");
      if (!logParent) throw new Error("log element missing");
      const log = logParent.querySelector("div") as HTMLElement;
      const rect = log.getBoundingClientRect();
      const pill = Array.from(document.querySelectorAll("aside div")).find(
        (d) =>
          d.childElementCount === 0 &&
          d.textContent?.trim() === "Stopped · session.interrupt",
      );
      if (!pill) throw new Error("interrupt pill missing");
      const p = pill.getBoundingClientRect();
      const notSent = document.querySelector("aside [data-notsent]");
      if (!notSent) throw new Error("notsent element missing");
      const t = notSent.getBoundingClientRect();
      return {
        container: { top: rect.top, bottom: rect.bottom },
        pill: { top: p.top, bottom: p.bottom },
        tray: { top: t.top, bottom: t.bottom },
        viewH: window.innerHeight,
      };
    });

  await expect
    .poll(
      async () => {
        const g = await geometry();
        return (
          // stopped turn fully inside the scroll container's visible rect…
          g.pill.top >= g.container.top - 1 &&
          g.pill.bottom <= g.container.bottom + 1 &&
          // …and the tray fully inside the window viewport, below the container.
          g.tray.top >= 0 &&
          g.tray.bottom <= g.viewH
        );
      },
      { timeout: 5_000 },
    )
    .toBe(true);
  expect(errors).toEqual([]);
});

/* Issue #15: the destructive remove action reads neutral (muted) with the accessible name "Remove"
   and shows a tooltip; Send is the solid primary. */
test("Issue #15: tray actions — Send primary, remove neutral named 'Remove' with tooltip", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  const panel = await stopWithTrayInPanel(page);

  const send = panel.locator("[data-notsent-send]").first();
  const remove = panel.getByRole("button", { name: "Remove", exact: true });
  await expect(send).toBeVisible();
  await expect(remove).toBeVisible();

  // Send reads primary (white text on a solid, saturated bg); remove reads neutral (muted) and
  // turns red on hover. Colours compared as computed strings — Tailwind v4 resolves to oklch, so
  // assert relationships, not rgb literals.
  const styles = await page.evaluate(() => {
    const sendEl = document.querySelector("aside [data-notsent-send]");
    const removeEl = document.querySelector("aside [data-notsent-remove]");
    if (!sendEl || !removeEl) throw new Error("notsent buttons missing");
    const s = getComputedStyle(sendEl);
    const r = getComputedStyle(removeEl);
    return {
      sendBg: s.backgroundColor,
      sendFg: s.color,
      removeColor: r.color,
    };
  });
  expect(styles.sendFg).toBe("rgb(255, 255, 255)"); // solid primary button
  expect(styles.sendBg).not.toBe("rgba(0, 0, 0, 0)");
  expect(styles.sendBg).not.toBe(styles.sendFg);
  expect(styles.removeColor).not.toBe(styles.sendBg); // remove is NOT painted like the primary
  expect(styles.removeColor).not.toBe("rgb(255, 255, 255)");

  // Neutral → red on hover.
  await remove.hover();
  await expect
    .poll(async () => {
      const c = await page.evaluate(() => {
        const el = document.querySelector("aside [data-notsent-remove]");
        if (!el) throw new Error("notsent remove missing");
        const r = getComputedStyle(el);
        return r.color;
      });
      return c !== styles.removeColor;
    })
    .toBe(true);

  // Tooltip appears on hover of the remove icon (Base UI popup = data-slot, no role=tooltip here).
  await remove.hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toContainText(
    "Remove",
    { timeout: 5_000 },
  );
  expect(errors).toEqual([]);
});

/* Issue #15: the app icon is the LilOS favicon, not Hermes. */
test("Issue #15: page declares the LilOS favicon link", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await expect(
    page.locator('link[rel="icon"][href="/favicon.ico"]'),
  ).toHaveCount(1);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
  const resp = await page.request.get("/favicon.ico");
  expect(resp.ok()).toBe(true);
  expect(errors).toEqual([]);
});
