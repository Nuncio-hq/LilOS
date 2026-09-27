import { expect, type Page, test } from "@playwright/test";

/* Issue #20 coverage: first run, system status, failure states, session & employee management,
   sidebar badges, composer attachments, realApp preview, suggestion chips removed.
   States the mock engine can't reach on its own are driven by the sidebar Preview menu
   (a prototype-only scenario switcher). Text/role assertions only — stable on CI Linux. */

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

function sidebar(page: Page) {
  return page.locator("aside").first();
}

async function pickScenario(page: Page, label: string) {
  await page.getByRole("button", { name: "Preview states" }).click();
  await page.getByRole("menuitemradio", { name: label, exact: true }).click();
}

async function openDM(page: Page, name: string) {
  await sidebar(page)
    .getByRole("button", { name: new RegExp(name) })
    .click();
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("AC-1 first run: relay connects, `default` is the first employee, DM opens in ≤3 steps", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await pickScenario(page, "First run");

  // Onboarding overlay: checks run by themselves, no token or terminal.
  await expect(page.getByText("Welcome to LilOS")).toBeVisible();
  await expect(page.getByText(/Connected · local relay/)).toBeVisible({
    timeout: 10_000,
  });
  // `default` is already listed as the first (and only) employee in the sidebar.
  await expect(
    sidebar(page).getByRole("button", { name: /Default/ }),
  ).toBeVisible();

  // Step 1 (and only click inside the flow): open the DM.
  await page.getByRole("button", { name: /Open DM with Default/ }).click();
  await expect(page.getByPlaceholder(/New session with Default/)).toBeVisible();
  await expect(page.getByText(/Start a session with Default/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("AC-2 system status: relay/harness/engine/model with state + reason, Copy diagnostics", async ({
  page,
  context,
}) => {
  const errors = watchConsole(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");

  await page.getByRole("button", { name: "System status" }).click();
  await expect(page.getByText("System status", { exact: true })).toBeVisible();
  for (const label of ["Relay", "Harness", "Engine", "Model"]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  // One-line reasons are shown, e.g. the engine line.
  await expect(page.getByText(/Hermes .+ · ready/)).toBeVisible();
  await expect(page.getByText(/responding/)).toBeVisible();

  await page.getByRole("button", { name: "Copy diagnostics" }).click();
  await expect(page.getByText("Diagnostics copied")).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("relay:");
  expect(clip).toContain("harness:");
  expect(clip).toContain("engine:");
  expect(clip).toContain("model:");
  expect(errors).toEqual([]);
});

test("AC-3 designed states: empty DM and loading sessions", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.goto("/");

  // Empty DM: Marketer has no sessions yet → designed empty state.
  await openDM(page, "Marketer");
  await expect(page.getByText(/Start a session with Marketer/)).toBeVisible();

  // Loading: skeleton rows where the session list will land.
  await openDM(page, "Builder");
  await pickScenario(page, "Loading sessions");
  await expect(page.locator("[data-session-skeleton]").first()).toBeVisible();
  expect(await page.locator("[data-session-skeleton]").count()).toBe(3);
  expect(errors).toEqual([]);
});

test("AC-3 designed states: reconnecting / harness down / engine down / version mismatch", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.goto("/");

  await pickScenario(page, "Reconnecting to relay");
  await expect(page.locator("[data-status-banner]")).toContainText(
    /reconnect/i,
  );

  await pickScenario(page, "Harness down");
  await expect(page.locator("[data-status-banner]")).toContainText(
    /Harness down/i,
  );

  await pickScenario(page, "Engine down");
  await expect(page.locator("[data-status-banner]")).toContainText(
    /Engine down/i,
  );

  await pickScenario(page, "Version mismatch");
  await expect(page.locator("[data-status-banner]")).toContainText(
    /Update LilOS/i,
  );
  // The status dialog names what the relay wants ("update X").
  await page.getByRole("button", { name: "System status" }).click();
  await expect(
    page.getByRole("dialog", { name: "System status" }),
  ).toContainText(/Protocol v2 required/i);
  await page.getByRole("button", { name: "Close" }).click();
  expect(errors).toEqual([]);
});

test("AC-3 designed states: model error and sleep interruption retry", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  await page.goto("/");

  // Session-level designed failure: alert card on the latest DM session + Retry.
  await openDM(page, "Builder");
  await pickScenario(page, "Model error");
  await expect(page.locator("[data-session-alert]")).toContainText(
    /Model error/i,
  );
  await page
    .locator("[data-session-alert]")
    .getByRole("button", { name: "Retry" })
    .click();
  await expect(
    page.getByPlaceholder(/is working\. Enter steers this turn/),
  ).toBeVisible({ timeout: 15_000 });

  await pickScenario(page, "Sleep interrupted");
  await expect(page.locator("[data-session-alert]")).toContainText(/slept/i);
  await expect(
    page.locator("[data-session-alert]").getByRole("button", { name: "Retry" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("AC-4 session management: filter, rename, archive and restore in the DM list", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await openDM(page, "Builder");

  // Filter by first message content.
  await expect(page.locator("[data-session]")).toHaveCount(2);
  await page.getByPlaceholder("Filter sessions").fill("summarise");
  await expect(page.locator("[data-session]")).toHaveCount(1);
  await expect(page.locator("[data-session]")).toContainText("Summarise");
  await page.getByPlaceholder("Filter sessions").fill("");

  // Rename via the row menu → the session shows its title.
  const d2 = page.locator('[data-session="d2"]');
  await d2.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: "Rename session" }).click();
  await page.getByLabel("Session title").fill("Monday summary");
  await page.getByLabel("Session title").press("Enter");
  await expect(d2).toContainText("Monday summary");

  // Filter matches the title too.
  await page.getByPlaceholder("Filter sessions").fill("monday");
  await expect(page.locator("[data-session]")).toHaveCount(1);
  await page.getByPlaceholder("Filter sessions").fill("");

  // Archive hides the row under a disclosure; Restore brings it back.
  await d2.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: "Archive session" }).click();
  await expect(page.locator("[data-session]")).toHaveCount(1);
  await page.getByRole("button", { name: /Archived \(1\)/ }).click();
  await expect(page.locator('[data-archived="true"]')).toHaveCount(1);
  await page
    .locator('[data-archived="true"]')
    .getByRole("button", { name: "Session actions" })
    .click();
  await page.getByRole("menuitem", { name: "Unarchive session" }).click();
  await expect(page.locator("[data-session]")).toHaveCount(2);
  expect(errors).toEqual([]);
});

test("AC-5 employee management: edit name + role, remove keeps profile, missing profile switch", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await openDM(page, "Builder");
  await page.getByRole("button", { name: "Profile" }).click();
  const panel = page.locator("aside").last();

  // Edit display name + role.
  await panel.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByText("Edit employee")).toBeVisible();
  await page.getByLabel("Display name").fill("Wren");
  await page.getByLabel("Role").fill("Staff Engineer");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    sidebar(page).getByRole("button", { name: /Wren/ }),
  ).toBeVisible();
  await expect(
    sidebar(page).getByRole("button", { name: /Staff Engineer/ }),
  ).toBeVisible();

  // Remove from company: the confirm copy states the engine profile is kept.
  await panel.getByRole("button", { name: "Edit" }).click();
  await page
    .getByRole("button", { name: "Remove from company" })
    .first()
    .click();
  await expect(page.locator("[role=alert]")).toContainText(
    "its sessions, memory, and skills",
  );
  await page
    .locator("[role=alert]")
    .getByRole("button", { name: "Remove from company" })
    .click();
  await expect(sidebar(page).getByRole("button", { name: /Wren/ })).toHaveCount(
    0,
  );
  await expect(page.getByText(/profile builder kept/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("AC-5 profile missing: card shows the state with Switch profile", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await pickScenario(page, "Profile missing");
  await openDM(page, "Marketer");
  await page.getByRole("button", { name: "Profile" }).click();
  const panel = page.locator("aside").last();

  await expect(panel.getByText(/isn't on the engine/)).toBeVisible();
  await panel.getByRole("combobox").click();
  await page.getByRole("option", { name: /\bbuilder\b/ }).click();
  await expect(panel.getByText(/isn't on the engine/)).toHaveCount(0);
  await expect(panel.getByText("builder", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("AC-6 sidebar badges: needs-approval count and running count per employee", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  await page.goto("/");
  const side = sidebar(page);

  // Seeded approval from Reviewer (#engineering m1) → amber badge. The
  // badge reads `needs you` since #71 (count stays in the tooltip).
  await expect(
    side
      .getByRole("button", { name: /Reviewer/ })
      .locator("[data-badge-approvals]"),
  ).toHaveText("needs you");

  // A live turn → running badge on the employee while it works.
  await openDM(page, "Builder");
  const box = page.getByPlaceholder(/New session with Builder/);
  await box.fill("Check the relay reconnect plan");
  await box.press("Enter");
  await expect(
    side
      .getByRole("button", { name: /Builder/ })
      .locator("[data-badge-running]"),
  ).toHaveText("1", { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("AC-7 composer attachments: pick, drop and paste show a chip before send", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await openDM(page, "Builder");
  const main = page.locator("main");

  // Pick via the paperclip's hidden file input.
  await main
    .locator('input[type="file"]')
    .setInputFiles({ name: "picked.png", mimeType: "image/png", buffer: PNG });
  await expect(main.getByText("picked.png")).toBeVisible();

  // Drop onto the composer form.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "dropped.png", { type: "image/png" }));
    const form = document.querySelector("main form");
    if (!form) throw new Error("form missing");
    form.dispatchEvent(
      new DragEvent("drop", { dataTransfer: dt, bubbles: true }),
    );
  });
  await expect(main.getByText("dropped.png")).toBeVisible();

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
  await expect(main.getByText("pasted.png")).toBeVisible();

  // Send: composer chips clear, the sent session row shows all three attachment names.
  await main.getByPlaceholder(/New session with Builder/).fill("see attached");
  await main.getByPlaceholder(/New session with Builder/).press("Enter");
  const sent = main.locator("[data-attachments]");
  await expect(sent).toContainText("picked.png");
  await expect(sent).toContainText("dropped.png");
  await expect(sent).toContainText("pasted.png");
  await expect(main.locator("form").getByText("picked.png")).toHaveCount(0); // composer's chip list is empty again
  expect(errors).toEqual([]);
});

test("AC-8 realApp preview: sidebar shows only Employees + status, no dead controls", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.goto("/");
  const side = sidebar(page);

  await page.getByRole("button", { name: "Preview states" }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "Real app", exact: true })
    .click();

  await expect(side.getByText("Employees")).toBeVisible();
  await expect(
    side.getByRole("button", { name: "System status" }),
  ).toBeVisible();
  await expect(side.getByRole("button", { name: /Builder/ })).toBeVisible();
  for (const gone of ["Inbox", "Needs you", "Tickets", "Company", "Projects"]) {
    await expect(side.getByText(gone, { exact: true })).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test("AC-9 mock suggestion chips are gone from the DM composer", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await openDM(page, "Builder");
  await expect(page.getByText("New session:")).toHaveCount(0);
  await expect(page.getByText("What's blocking the relay?")).toHaveCount(0);
  await expect(page.getByText("Explain packages/contracts")).toHaveCount(0);
  expect(errors).toEqual([]);
});
