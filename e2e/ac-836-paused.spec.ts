import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  openDefaultAgent,
  pickPorts,
  relayRpc,
  type Stack,
  skipFirstRun,
  startChat,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * #836: the real app reads as a Hermes app — the company layer paused, not
 * deleted (D-#836). One stack that opts OUT of bootStack's company-on
 * default (the product's no-env default IS paused): the sidebar is
 * Search · Home · Needs you · Threads · Projects, Home is the daily Home
 * (a composer that talks to the agent, Needs you, threads by project),
 * the hidden pages land on Home and a ticket/goal link on its project.
 * The records still answer: the agent's page opens off the composer and
 * the trail, Remove from LilOS stays on it (#856), and `?company=1`
 * shows the layer back untouched.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, "..", "test-results", "ac-836");

let stack: Stack;
let agent: { id: string; name: string };
test.beforeAll(async () => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  /* "0" beats bootStack's "1" — extraEnv lands last. The product default
     (no env at all) is paused, which is what this spec exercises. */
  stack = await bootStack("ac836", await pickPorts(), { LILOS_COMPANY: "0" });
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.locator("#v3-main");
const greeting = (page: Page) =>
  main(page).getByRole("heading", {
    level: 1,
    name: /Good (morning|afternoon|evening)/,
  });

test("the sidebar is the daily app's, and Home is the daily Home with its composer chips", async ({
  page,
}) => {
  test.setTimeout(120_000);
  agent = await openDefaultAgent(page, stack.webUrl);

  /* A project to head the section the label names (the label is not drawn
     for a company of no folders). */
  const folder = `${stack.home}/lil`;
  mkdirSync(folder, { recursive: true });
  await relayRpc(page, stack, "projects.create", { folder, name: "LilOS" });

  const side = v3Sidebar(page);

  // The daily app's nav; the company layer's is not there.
  for (const name of ["Search", "Home", "Needs you", "Threads"])
    await expect(
      side.getByRole("button", { name: new RegExp(`^${name}`) }),
    ).toBeVisible();
  await expect(side.getByText("Projects", { exact: true })).toBeVisible();
  await expect(side.getByRole("button", { name: /LilOS/ })).toBeVisible();
  for (const name of ["Work", "Goals", "Inbox", "People", "Hire an agent"])
    await expect(
      side.getByRole("button", { name: new RegExp(`^${name}`) }),
    ).toHaveCount(0);
  await expect(side.getByText("People", { exact: true })).toHaveCount(0);
  await expect(side.locator("[data-company-label]")).toHaveCount(0);
  /* The roster is there as the Agents section — a flat list with its ＋ to
     add one (#870): browsable rows, not a page you navigate to. */
  await expect(side.getByText("Agents", { exact: true })).toBeVisible();
  await expect(side.getByRole("button", { name: /default/i })).toBeVisible();
  await expect(side.getByRole("button", { name: "Add agent" })).toBeVisible();
  /* Nav-only sidebar (#862's accepted design): the thread rows, shelves and
     folds all live on the Threads page — the sidebar mirrors none of it. */
  await expect(side.locator("[data-thread-row]")).toHaveCount(0);
  await expect(side.locator("[data-fold]")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/sidebar.png` });

  /* A turn that pauses on an approval ask, so Home's one list has a
     needs-you row to read. */
  await startChat(page, stack.webUrl, agent, "Add a footer to the page");

  /* Home is the daily Home (#862): the composer that talks to the agent —
     agent, project, model+effort and access one click each — then Pinned
     (hidden while empty) and ONE list: needs-you rows highlighted with
     their quick action, then working, then the rest of recent. The old
     Needs you block and its "Nothing needs you." line are gone; no Goals
     section, no team table. */
  await side.getByRole("button", { name: /^Home/ }).click();
  await expect(greeting(page)).toBeVisible({ timeout: 30_000 });
  const box = main(page).getByPlaceholder(
    new RegExp(`^Message ${agent.name}…`),
  );
  await expect(box).toBeVisible();
  await expect(main(page).getByTitle("Agent", { exact: true })).toBeVisible();
  await expect(main(page).getByTitle(/^Project · /)).toBeVisible();
  const model = main(page).locator("[data-slot='model-picker-trigger']");
  await expect(model).toBeVisible();
  await expect(model.locator("[data-effort]")).toBeVisible();
  await expect(main(page).locator("[data-slot='access-pill']")).toBeVisible();
  /* The merged list under the composer: the ask's row wears the Needs-you
     pill and its Deny/Approve on the row itself. */
  await expect(
    main(page).getByRole("heading", { name: /Threads/ }),
  ).toBeVisible();
  await expect(
    main(page).getByRole("button", { name: "Approve", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    main(page).getByText("Needs you", { exact: true }),
  ).toBeVisible();
  /* Empty sections hide: nothing is pinned, so no Pinned head; the ask
     arrived so no "Nothing needs you." line exists to draw anyway. */
  await expect(main(page).getByRole("heading", { name: "Pinned" })).toHaveCount(
    0,
  );
  await expect(main(page).getByText("Nothing needs you.")).toHaveCount(0);
  await expect(main(page).getByRole("heading", { name: "Goals" })).toHaveCount(
    0,
  );
  await page.screenshot({ path: `${SHOTS}/home.png` });
});

test("hidden pages land on Home; ticket and goal links land on their project", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/`);
  await expect(greeting(page)).toBeVisible({ timeout: 30_000 });

  // A real project with a real goal and ticket underneath (D-#776 records).
  const folder = `${stack.home}/lil`;
  mkdirSync(folder, { recursive: true });
  const { project } = await relayRpc<{
    project: { id: string; key: string; name: string };
  }>(page, stack, "projects.create", { folder, name: "LilOS" });
  const { goal } = await relayRpc<{ goal: { id: string } }>(
    page,
    stack,
    "goals.create",
    { project: project.id, title: "Ship the daily app" },
  );
  const { ticket } = await relayRpc<{ ticket: { id: string } }>(
    page,
    stack,
    "tickets.create",
    { project: project.id, title: "Hide the company layer" },
  );

  for (const hidden of ["work", "goals", "inbox", "people", "hire"]) {
    await page.goto(`${stack.webUrl}/#?page=${hidden}`);
    await expect(greeting(page)).toBeVisible({ timeout: 30_000 });
    await expect(
      main(page).getByRole("heading", { level: 1 }),
    ).not.toContainText(/Work|Goals|People|Hire/);
  }

  // A stale ticket or goal link still lands somewhere real: its project.
  for (const [kind, id] of [
    ["ticket", ticket.id],
    ["goal", goal.id],
  ] as const) {
    await page.goto(`${stack.webUrl}/#?open=${kind}:${id}`);
    await expect(v3Peek(page).getByRole("heading", { level: 1 })).toContainText(
      project.name,
      { timeout: 30_000 },
    );
    await page.keyboard.press("Escape");
  }
});

test("agents stay reachable: composer picker, the agent page and the trail", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openDefaultAgent(page, stack.webUrl);

  /* A second agent so Remove is offered — the agent page keeps "Remove from
     LilOS" (#856) with the company layer paused. */
  await relayRpc(page, stack, "employees.create", {
    name: "Scout",
    role: "Researcher",
    profile: "default",
    status: "offline",
  });
  await page.goto(`${stack.webUrl}/#?open=agent:${agent.id}`);
  const peek = v3Peek(page);
  await expect(
    peek.getByRole("heading", { level: 1, name: agent.name }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    peek.getByRole("button", { name: "Remove from LilOS" }),
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/agent.png` });

  // From the agent's page, Message opens the draft beside it — the composer
  // keeps its agent picker (every agent is a row) and the chips.
  await peek.getByRole("button", { name: "Message" }).click();
  const draft = peek.getByPlaceholder(new RegExp(`^Message ${agent.name}…`));
  await expect(draft).toBeVisible({ timeout: 30_000 });
  await peek.getByTitle("Agent", { exact: true }).click();
  const menu = page.getByRole("menu");
  await expect(
    menu.getByRole("menuitemradio", { name: new RegExp(agent.name) }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitemradio", { name: /Scout/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(peek.getByTitle(/^Project · /)).toBeVisible();
  await expect(
    peek.locator("[data-slot='model-picker-trigger']"),
  ).toBeVisible();
  await expect(peek.locator("[data-slot='access-pill']")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/composer.png` });

  // A send swaps the draft for its thread; the trail's agent crumb is the
  // thread's way back to the page (D-#769), so it is still reachable.
  await draft.fill("say hi");
  await peek.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/open=([^&]*,)?thread:[^&,]+/, {
    timeout: 30_000,
  });
  await peek
    .getByRole("navigation", { name: "Trail" })
    .getByRole("button", { name: agent.name })
    .click();
  await expect(
    peek.getByRole("heading", { level: 1, name: agent.name }),
  ).toBeVisible({ timeout: 30_000 });
});

test("?company=1 shows the company layer back, untouched", async ({ page }) => {
  test.setTimeout(120_000);
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/?company=1`);
  const side = v3Sidebar(page);
  await expect(side.getByText("People", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  for (const name of ["Work", "Goals", "Hire an agent"])
    await expect(
      side.getByRole("button", { name: new RegExp(`^${name}`) }),
    ).toBeVisible();
  await expect(side.locator("[data-company-label]")).not.toHaveText("");
  await expect(side.getByRole("button", { name: /default/i })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/company.png` });

  // And a company route resolves as itself again.
  await page.goto(`${stack.webUrl}/?company=1#?page=people`);
  await expect(
    main(page).getByRole("heading", { level: 1, name: "People" }),
  ).toBeVisible({ timeout: 30_000 });
});
