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
  startChat,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * #777 — the CEO loop. One test per acceptance criterion, on engine-fake.
 * The owner acts through the page. The CEO acts through the tools a wake
 * or a `surfaces:` line names. Shots stay under test-results/ac-777.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, "../test-results/ac-777");

let stack: Stack;
let agent: { id: string; name: string };
let worker: { id: string; name: string };
let project: { id: string; key: string };
let goalId: string;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  stack = await bootStack("ac777", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.locator("#v3-main");
const CHIP = "[title='Holds the CEO position']";

async function shot(page: Page, name: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({
      path: path.join(SHOTS, `${name}-${colorScheme}.png`),
      animations: "disabled",
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

async function home(page: Page) {
  await v3Sidebar(page)
    .getByRole("button", { name: "Home", exact: true })
    .click();
}

test("a goal given to the CEO becomes tickets with owners in one turn", async ({
  page,
}) => {
  test.setTimeout(180_000);
  agent = await openDefaultAgent(page, stack.webUrl);
  const folder = `${stack.home}/page`;
  mkdirSync(folder, { recursive: true });
  project = (
    await relayRpc<{ project: { id: string; key: string } }>(
      page,
      stack,
      "projects.create",
      { folder, name: "Pages" },
    )
  ).project;
  goalId = (
    await relayRpc<{ goal: { id: string } }>(page, stack, "goals.create", {
      project: project.id,
      title: "Ship the page",
    })
  ).goal.id;
  worker = (
    await relayRpc<{ employee: { id: string; name: string } }>(
      page,
      stack,
      "employees.create",
      {
        name: "Page",
        role: "Writer",
        status: "online",
        profile: "builder",
        model: "fake-large",
        instructions: "You write pages.",
      },
    )
  ).employee;

  await page.goto(
    `${stack.webUrl}/#?page=people&open=agent:${encodeURIComponent(agent.id)}`,
  );
  await v3Peek(page).getByRole("button", { name: "Make CEO" }).click();
  await expect(v3Peek(page).locator(CHIP)).toBeVisible({ timeout: 15_000 });

  const ticketId = `${project.key}-1`;
  await startChat(
    page,
    stack.webUrl,
    agent,
    `surfaces: ticket ${project.key} | Write the page | goal:${goalId} | owner:${worker.id}; ticket-assign ${ticketId} | ${worker.id}; update plan | Split the goal into one ticket. | goal:${goalId} | ticket:${ticketId}`,
  );
  await expect(v3Peek(page).locator("[data-agentturn]").first()).toBeVisible({
    timeout: 90_000,
  });
  const { tickets } = await relayRpc<{
    tickets: { id: string; ownerId?: string; goalId?: string }[];
  }>(page, stack, "tickets.list", {});
  const written = tickets.find((t) => t.id === ticketId);
  expect(written?.ownerId).toBe(worker.id);
  expect(written?.goalId).toBe(goalId);
  await home(page);
  await expect(main(page)).toContainText("Split the goal into one ticket.", {
    timeout: 30_000,
  });
  await shot(page, "1-plan");
});

test("a finished ticket wakes the CEO, who checks it and assigns the next", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openDefaultAgent(page, stack.webUrl);
  const { ticket: first } = await relayRpc<{ ticket: { id: string } }>(
    page,
    stack,
    "tickets.create",
    { project: project.key, title: "First step" },
  );
  const { ticket: next } = await relayRpc<{ ticket: { id: string } }>(
    page,
    stack,
    "tickets.create",
    {
      project: project.key,
      title: "Next step",
      ownerId: worker.id,
      waitingOn: { kind: "ticket", ticketId: first.id },
    },
  );
  await page.goto(
    `${stack.webUrl}/#?page=work&open=ticket:${encodeURIComponent(first.id)}`,
  );
  await v3Peek(page).getByRole("button", { name: "Mark done" }).click();
  await expect
    .poll(
      async () => {
        const { conversations } = await relayRpc<{
          conversations: { ticketId?: string }[];
        }>(page, stack, "conversations.list", { includeArchived: true });
        return conversations.some((c) => c.ticketId === next.id);
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await home(page);
  await expect(main(page)).toContainText(`Checked ${first.id}.`, {
    timeout: 30_000,
  });
  await shot(page, "2-checked");
});

test("a stuck thread is handed to another agent, with an update", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openDefaultAgent(page, stack.webUrl);
  const { ticket } = await relayRpc<{ ticket: { id: string } }>(
    page,
    stack,
    "tickets.create",
    { project: project.key, title: "Stuck step" },
  );
  const { conversation } = await relayRpc<{ conversation: { id: string } }>(
    page,
    stack,
    "tickets.assign",
    { id: ticket.id, ownerId: worker.id },
  );
  await page.goto(
    `${stack.webUrl}/#?page=threads&open=thread:${encodeURIComponent(conversation.id)}`,
  );
  await expect(v3Peek(page).locator("[data-agentturn]").first()).toBeVisible({
    timeout: 90_000,
  });
  const box = v3Peek(page).getByPlaceholder(`Message ${worker.name}…`);
  await box.fill("stuck:");
  await v3Peek(page).getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("The CEO will handle it.")).toBeVisible({
    timeout: 30_000,
  });
  await shot(page, "3-stuck");
  await expect(v3Peek(page)).toContainText(`Handed to ${agent.name}`, {
    timeout: 60_000,
  });
  await home(page);
  await expect(main(page)).toContainText(
    `Handed ${ticket.id} on. It was stuck.`,
    { timeout: 30_000 },
  );
  await expect(page.getByText("The CEO will handle it.")).toHaveCount(0);
  await shot(page, "3-handed");
});

test("Home shows the latest update and Inbox lists them", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${stack.webUrl}/#?page=home`);
  await expect(main(page)).toContainText("Handed", { timeout: 30_000 });
  await expect(main(page)).toContainText("It was stuck.");
  await shot(page, "4-home");
  await v3Sidebar(page)
    .getByRole("button", { name: "Inbox", exact: true })
    .click();
  await expect(main(page)).toContainText("Split the goal into one ticket.");
  await expect(main(page)).toContainText("Checked");
  await expect(main(page)).toContainText("It was stuck.");
  await shot(page, "4-inbox");
});
