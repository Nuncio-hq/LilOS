import { expect, test } from "@playwright/test";

/**
 * Settings → Phone, prototype app (mock company): unpairing the phone that
 * just paired, while the card still says "Paired", must never bring back the
 * QR of the offer that phone already used. The card is gone and the page
 * shows its empty state (or a fresh offer if you ask for one).
 */

const qr = (page: import("@playwright/test").Page) =>
  page.getByRole("img", { name: "Pairing code to scan with your iPhone" });

test("unpairing while 'Paired' shows never brings back the spent code", async ({
  page,
}) => {
  await page.goto("/?page=settings&view=phone");
  // The mock company starts with one paired phone: remove it first so the
  // page is empty and the only device is the one the offer pairs.
  await page.getByRole("button", { name: "Unpair", exact: true }).click();
  await page.getByRole("button", { name: "Unpair", exact: true }).click();
  const empty = page.getByText("No phone paired yet");
  await expect(empty).toBeVisible();

  await page.getByRole("button", { name: "Pair a phone" }).click();
  await expect(qr(page)).toBeVisible();

  // The mock phone scans the code two seconds later: the card says Paired.
  await expect(page.getByText("Paired", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(qr(page)).toHaveCount(0);

  // Unpair that very phone before the card leaves on its own.
  await page.getByRole("button", { name: "Unpair", exact: true }).click();
  await page.getByRole("button", { name: "Unpair", exact: true }).click();

  // The spent offer does not come back: no QR, no code, the empty state.
  await expect(empty).toBeVisible();
  await expect(qr(page)).toHaveCount(0);
  await expect(page.getByText("Paired", { exact: true })).toHaveCount(0);
  await page.waitForTimeout(2800); // past the card's own 2.2s leave timer
  await expect(qr(page)).toHaveCount(0);
  await expect(empty).toBeVisible();
});
