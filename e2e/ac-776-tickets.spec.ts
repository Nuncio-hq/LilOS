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
} from "./helpers/stack";

/**
 * #776: tickets and goals in the real app. One test per acceptance
 * criterion, on the engine-fake stack. Light and dark shots of each
 * criterion's moment.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, "../test-results/ac-776");
const ARTIFACTS = "/opt/cursor/artifacts/ac-776";

let stack: Stack;
let agent: { id: string; name: string };

test.beforeAll(async () => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(ARTIFACTS, { recursive: true });
  stack = await bootStack("ac776", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.locator("#v3-main");

async function shot(page: Page, name: string) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const file = `${name}-${colorScheme}.png`;
    await page.screenshot({
      path: path.join(SHOTS, file),
      animations: "disabled",
    });
    const { copyFileSync } = await import("node:fs");
    copyFileSync(path.join(SHOTS, file), path.join(ARTIFACTS, file));
  }
  await page.emulateMedia({ colorScheme: "light" });
}

async function project() {
  const { project } = await relayRpc<{
    project: { id: string; key: string; name: string };
  }>(pageOf(), stack, "projects.create", {
    folder: `${stack.home}/lil`,
    name: "LilOS",
  });
  return project;
}

/** The page the relay call runs in — set by each test before it calls. */
let pageOf = (): Page => {
  throw new Error("page not set");
};

async function ready(page: Page) {
  agent = await openDefaultAgent(page, stack.webUrl);
  pageOf = () => page;
}

test("a ticket from the owner and from an agent lands on Work and its project", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await ready(page);
  const proj = await project();
  await relayRpc(page, stack, "tickets.create", {
    project: proj.key,
    title: "From you",
    waitingOn: { kind: "you" },
  });
  await startChat(
    page,
    stack.webUrl,
    agent,
    `surfaces: ticket ${proj.key} | From the agent`,
  );
  await expect(
    v3Peek(page).getByRole("button", { name: "Copy" }).first(),
  ).toBeVisible({ timeout: 90_000 });

  await page.goto(`${stack.webUrl}/#?page=work`);
  await expect(main(page).getByText("Waiting on you")).toBeVisible({
    timeout: 30_000,
  });
  await expect(main(page).getByText("From you")).toBeVisible();
  await expect(main(page).getByText("Scheduled")).toBeVisible();
  await expect(main(page).getByText("From the agent")).toBeVisible();
  await shot(page, "ac-1-work");

  await page.goto(`${stack.webUrl}/#?page=project&id=${proj.id}`);
  await expect(main(page).getByText("From you")).toBeVisible();
  await expect(main(page).getByText("From the agent")).toBeVisible();
});

test("assign opens the owner's thread; reassign adds a second hand", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await ready(page);
  const proj = await project();
  const { ticket } = await relayRpc<{ ticket: { id: string } }>(
    page,
    stack,
    "tickets.create",
    { project: proj.key, title: "Hands" },
  );
  await relayRpc(page, stack, "tickets.assign", {
    id: ticket.id,
    ownerId: agent.id,
  });
  const { employee } = await relayRpc<{
    employee: { id: string; name: string };
  }>(page, stack, "employees.create", { name: "Blair", role: "Notes" });
  await relayRpc(page, stack, "tickets.assign", {
    id: ticket.id,
    ownerId: employee.id,
  });

  await page.goto(`${stack.webUrl}/#?page=work&open=ticket:${ticket.id}`);
  await expect(v3Peek(page).getByText("changed hands 1×")).toBeVisible({
    timeout: 30_000,
  });
  await expect(v3Peek(page).getByText(agent.name).first()).toBeVisible();
  await expect(v3Peek(page).getByText("Blair").first()).toBeVisible();
  await shot(page, "ac-2-hands");
});

test("a ticket waiting on another moves when that one is done", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await ready(page);
  const proj = await project();
  const { ticket: blocker } = await relayRpc<{ ticket: { id: string } }>(
    page,
    stack,
    "tickets.create",
    { project: proj.key, title: "Blocker", ownerId: agent.id },
  );
  const { ticket: waiter } = await relayRpc<{ ticket: { id: string } }>(
    page,
    stack,
    "tickets.create",
    {
      project: proj.key,
      title: "After the blocker",
      ownerId: agent.id,
      waitingOn: { kind: "ticket", ticketId: blocker.id },
    },
  );
  await page.goto(`${stack.webUrl}/#?page=work`);
  await expect(main(page).getByText("Waiting on another ticket")).toBeVisible({
    timeout: 30_000,
  });
  await relayRpc(page, stack, "tickets.update", {
    id: blocker.id,
    status: "done",
  });
  await page.reload();
  await expect(main(page).getByText("Waiting on another ticket")).toHaveCount(
    0,
    { timeout: 30_000 },
  );
  await expect(main(page).getByText("Moving")).toBeVisible();
  await expect(main(page).getByText("After the blocker")).toBeVisible();

  await page.goto(`${stack.webUrl}/#?page=work&open=ticket:${waiter.id}`);
  await expect(
    v3Peek(page).getByText(`${blocker.id} is done, so this can move.`),
  ).toBeVisible({ timeout: 30_000 });
  await shot(page, "ac-3-moved");
});
