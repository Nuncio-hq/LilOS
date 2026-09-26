import { expect, type Page, test } from "@playwright/test";

/* Issue #31 coverage: AC-1 composer image attachments — pick/drop/paste show an
   image chip with a thumbnail, a chip can be removed before send, oversize is
   rejected with a toast, and the employee's answer references the image. */

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function openDM(page: Page, name: string) {
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: new RegExp(name) })
    .click();
}

test("AC-1 pick, drop and paste an image: thumbnail chips, remove before send", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await openDM(page, "Builder");
  const main = page.locator("main");
  const form = main.locator("form");

  // Pick via the paperclip's hidden file input.
  await main
    .locator('input[type="file"]')
    .setInputFiles({ name: "picked.png", mimeType: "image/png", buffer: PNG });
  // Drop onto the composer form.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "dropped.png", { type: "image/png" }));
    const el = document.querySelector("main form");
    if (!el) throw new Error("form missing");
    el.dispatchEvent(
      new DragEvent("drop", { dataTransfer: dt, bubbles: true }),
    );
  });
  // Paste into the textarea.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["y"], "pasted.png", { type: "image/png" }));
    const ta = document.querySelector("main textarea");
    if (!ta) throw new Error("textarea missing");
    ta.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }),
    );
  });

  for (const name of ["picked.png", "dropped.png", "pasted.png"]) {
    await expect(form.getByText(name)).toBeVisible();
  }
  // Image chips render a thumbnail <img>, not just a filename.
  await expect(form.locator('img[alt="picked.png"]')).toBeVisible();

  // Remove one chip before send (the chip's remove control sits over the thumbnail).
  await form.getByRole("button", { name: "Remove attachment" }).nth(1).click();
  await expect(form.getByText("dropped.png")).toHaveCount(0);
  await expect(form.getByText("picked.png")).toBeVisible();
  expect(errors).toEqual([]);
});

test("AC-1 an image over the size cap is rejected with a toast and no chip", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await openDM(page, "Builder");
  const main = page.locator("main");

  // A file just over the 10 MiB app cap.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], "huge.png", {
        type: "image/png",
      }),
    );
    const el = document.querySelector("main form");
    if (!el) throw new Error("form missing");
    el.dispatchEvent(
      new DragEvent("drop", { dataTransfer: dt, bubbles: true }),
    );
  });

  await expect(page.getByText(/exceed the maximum size/)).toBeVisible();
  await expect(main.locator("form").getByText("huge.png")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("AC-2 the employee's answer references the image that came through", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await openDM(page, "Builder");
  const main = page.locator("main");

  await main
    .locator('input[type="file"]')
    .setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG });
  await main
    .getByPlaceholder(/New session with Builder/)
    .fill("what does this show");
  await main.getByPlaceholder(/New session with Builder/).press("Enter");

  // The thread opens: Oscar's turn shows the attachment chip with a thumbnail…
  const thread = page.locator("[data-attachments]");
  await expect(thread).toContainText("shot.png");
  await expect(thread.locator('img[alt="shot.png"]')).toBeVisible();

  // …and the employee's answer (in the thread panel) names what arrived.
  const panel = page.getByRole("tabpanel", { name: "Thread" });
  const reply = panel.getByText(/reached me on the prompt as an image block/);
  await expect(reply).toBeVisible({ timeout: 30_000 });
  await expect(
    panel.getByText(/shot\.png \(image\/png, \d+ bytes\)/),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
