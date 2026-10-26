import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  pickPorts,
  relayRpc,
  type Stack,
  skipFirstRun,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * #870: hiring while the company layer is paused — an Agents section in the
 * sidebar with a ＋, and "Add agent…" at the bottom of the composer's agent
 * menu. Both open the same small dialog — Who? (the engine's profiles plus
 * every runtime `system.status.runtimes` reports, the ones it cannot run
 * greyed with its reason), Name, Hire — and the hire lands ready to message.
 * The agent's page header is click-to-rename (and ⋯ → Rename), Enter saving
 * through `employees.update`. The old Hire page stays on `?company=1`.
 */

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  /* "0" beats bootStack's company-on default — this spec is the paused
     product (D-#836). */
  stack = await bootStack("v3addagent", await pickPorts(), {
    LILOS_COMPANY: "0",
  });
});
test.afterAll(async () => {
  await stack?.stop();
});
test.describe.configure({ mode: "serial" });

const side = (page: Page) => v3Sidebar(page);
const dialog = (page: Page) => page.getByRole("dialog", { name: "Add agent" });
const who = (page: Page) =>
  dialog(page).getByRole("radiogroup", { name: "Who?" });

test("the sidebar's Agents section lists the roster and a ＋ that opens the dialog", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/`);

  /* The paused sidebar's one agent section: the daily roster as plain rows,
     no People page, and the ＋ as its only chrome. */
  await expect(side(page).getByText("Agents", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    side(page).getByRole("button", { name: /Default/ }),
  ).toBeVisible();
  await expect(
    side(page).getByRole("button", { name: "Add agent" }),
  ).toBeVisible();
  await expect(
    side(page).getByRole("button", { name: "Hire an agent" }),
  ).toHaveCount(0);

  await side(page).getByRole("button", { name: "Add agent" }).click();
  const who_ = who(page);
  await expect(who_).toBeVisible({ timeout: 30_000 });
  /* Who? = the engine's profiles nobody runs (Builder, Marketer, Reviewer —
     Default is hired) plus the runtime roster. */
  for (const name of ["Builder", "Marketer", "Reviewer"])
    await expect(
      who_.getByRole("radio", { name: new RegExp(name) }),
    ).toBeVisible();
  await expect(who_.getByRole("radio", { name: /Default/ })).toHaveCount(0);
  /* The runtime catalog row is there whether or not its CLI is installed:
     greyed with the probe's reason when it is not. */
  const devin = who_.getByRole("radio", { name: /Devin/ });
  await expect(devin).toBeVisible({ timeout: 30_000 });
  if (await devin.isDisabled())
    await expect(devin).toContainText(/\S/, { timeout: 5_000 });
});

test("hire a Hermes profile: it lands in Agents, selected and ready to message", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/`);
  await side(page)
    .getByRole("button", { name: "Add agent" })
    .click({ timeout: 60_000 });

  const dlg = dialog(page);
  await expect(who(page)).toBeVisible({ timeout: 30_000 });
  // Name follows the picked kind — Builder — until it is edited.
  const name = dlg.getByLabel("Name");
  await expect(name).toHaveValue("Builder");
  await name.fill("Nova");
  await dlg.getByRole("button", { name: "Hire", exact: true }).click();

  /* The dialog closes into a new chat on the hire — the composer IS the
     selection, addressed to it and ready to send. */
  await expect(dlg).toHaveCount(0);
  const box = v3Peek(page).getByPlaceholder("Message Nova…");
  await expect(box).toBeVisible({ timeout: 30_000 });
  await expect(side(page).getByRole("button", { name: /Nova/ })).toBeVisible();

  // Ready to message: one send swaps the draft for its thread.
  await box.fill("say hi");
  await v3Peek(page).getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/open=([^&]*,)?thread:[^&,]+/, {
    timeout: 30_000,
  });
});

test("the composer's 'Add agent…' opens the same dialog and selects the hire", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/#?page=threads&open=newchat:none`);
  const peek = v3Peek(page);
  const chip = peek.getByTitle("Agent", { exact: true });
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await chip.click();
  await peek
    .getByRole("menu")
    .getByRole("menuitem", { name: "Add agent…" })
    .click();

  const dlg = dialog(page);
  const who_ = who(page);
  await expect(who_).toBeVisible({ timeout: 30_000 });
  await who_.getByRole("radio", { name: /Marketer/ }).click();
  const name = dlg.getByLabel("Name");
  await expect(name).toHaveValue("Marketer");
  await name.fill("Sage");
  await dlg.getByRole("button", { name: "Hire", exact: true }).click();

  /* Same draft, new agent: the box answers to the hire without leaving the
     composer. */
  await expect(dlg).toHaveCount(0);
  await expect(peek.getByPlaceholder("Message Sage…")).toBeVisible({
    timeout: 30_000,
  });
});

test("click-to-rename on the agent page: Enter saves, the roster follows", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/`);
  await side(page)
    .getByRole("button", { name: /Nova/ })
    .click({ timeout: 60_000 });
  const peek = v3Peek(page);
  await expect(
    peek.getByRole("heading", { level: 1, name: "Nova" }),
  ).toBeVisible({ timeout: 30_000 });

  /* The name is the control: click it, type, Enter. `employees.update`
     writes it — the engine profile and the sidebar row both follow. */
  await peek.getByRole("button", { name: "Nova" }).click();
  const box = peek.getByLabel("Agent name");
  await expect(box).toHaveValue("Nova");
  await box.fill("Nova Two");
  await box.press("Enter");
  await expect(
    peek.getByRole("heading", { level: 1, name: "Nova Two" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    side(page).getByRole("button", { name: /Nova Two/ }),
  ).toBeVisible();

  // ⋯ → Rename is the same box's other door; Esc only closes the box.
  await peek.getByRole("button", { name: "Agent actions" }).click();
  await peek.getByRole("menuitem", { name: "Rename" }).click();
  await expect(peek.getByLabel("Agent name")).toHaveValue("Nova Two");
  await page.keyboard.press("Escape");
  await expect(peek.getByLabel("Agent name")).toHaveCount(0);
  await expect(
    peek.getByRole("heading", { level: 1, name: "Nova Two" }),
  ).toBeVisible();

  /* And it is the real record: the relay answers employees.list with the
     new name. */
  const { employees } = await relayRpc<{ employees: { name: string }[] }>(
    page,
    stack,
    "employees.list",
    {},
  );
  expect(employees.some((e) => e.name === "Nova Two")).toBe(true);
});
