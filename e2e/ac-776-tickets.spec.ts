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
  v3Main,
  v3Peek,
} from "./helpers/stack";

/**
 * #776: tickets and goals in the real app. One test per acceptance
 * criterion. The owner acts through the page (New, hand to…, Mark done);
 * the agent acts through the tool. Light and dark shots of each
 * criterion's moment live only under test-results/ac-776.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, "../test-results/ac-776");

let stack: Stack;
let agent: { id: string; name: string };

test.beforeAll(async () => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
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
    await page.screenshot({
      path: path.join(SHOTS, `${name}-${colorScheme}.png`),
      animations: "disabled",
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

async function project() {
  /* The new-chat draft picks the first project (D-#771). The folder has to
     exist on disk or the agent's session never starts and the tool never
     runs — a missing cwd looks like the shell itself is missing. */
  const folder = `${stack.home}/lil`;
  mkdirSync(folder, { recursive: true });
  const { project } = await relayRpc<{
    project: { id: string; key: string; name: string };
  }>(pageOf(), stack, "projects.create", {
    folder,
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

async function ticketNamed(title: string) {
  const { tickets } = await relayRpc<{
    tickets: { id: string; title: string }[];
  }>(pageOf(), stack, "tickets.list", {});
  const hit = tickets.find((t) => t.title === title);
  if (!hit) throw new Error(`no ticket titled ${title}`);
  return hit;
}

test("a ticket from the owner and from an agent lands on Work and its project", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await ready(page);
  const proj = await project();

  await page.goto(`${stack.webUrl}/#?page=work`);
  await expect(main(page).getByRole("button", { name: "New" })).toBeVisible({
    timeout: 30_000,
  });
  /* New opens the ask draft — a destination, not an item the page lists, so
     it IS the page now (D-#769). */
  await main(page).getByRole("button", { name: "New" }).click();
  const draft = v3Main(page);
  await expect(draft.getByText("New chat", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(draft.getByRole("heading", { level: 1 })).toHaveText(agent.name);
  await expect(draft.getByText("Turn it into a ticket")).toHaveCount(0);

  await startChat(
    page,
    stack.webUrl,
    agent,
    `surfaces: ticket ${proj.key} | From you | you`,
  );
  await expect(
    v3Peek(page).getByRole("button", { name: "Copy" }).first(),
  ).toBeVisible({ timeout: 90_000 });
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

  /* A project linked straight IS the page (D-#769) — its tickets are on
     that record, the same place the project spec reads a thread. */
  await page.goto(`${stack.webUrl}/#?page=project&id=${proj.id}`);
  const projPage = v3Main(page);
  await expect(projPage.getByText("Open tickets")).toBeVisible({
    timeout: 30_000,
  });
  await expect(projPage.getByText("From you")).toBeVisible();
  await expect(projPage.getByText("From the agent")).toBeVisible();
});

test("assign opens the owner's thread; reassign adds a second hand", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await ready(page);
  const proj = await project();
  await startChat(
    page,
    stack.webUrl,
    agent,
    `surfaces: ticket ${proj.key} | Hands`,
  );
  await expect(
    v3Peek(page).getByRole("button", { name: "Copy" }).first(),
  ).toBeVisible({ timeout: 90_000 });
  const ticket = await ticketNamed("Hands");
  const { employee } = await relayRpc<{
    employee: { id: string; name: string };
  }>(page, stack, "employees.create", { name: "Blair", role: "Notes" });

  await page.goto(`${stack.webUrl}/#?page=work&open=ticket:${ticket.id}`);
  const peek = v3Peek(page);
  await expect(
    peek.getByRole("button", { name: "Ask about this" }),
  ).toBeVisible({ timeout: 30_000 });
  await peek.getByRole("button", { name: "Ask about this" }).click();
  await expect(peek.getByRole("textbox")).toHaveValue(`About ${ticket.id}: `);
  await expect(peek.getByRole("heading", { level: 1 })).toHaveText(agent.name);

  await page.goto(`${stack.webUrl}/#?page=work&open=ticket:${ticket.id}`);
  await expect(peek.getByRole("button", { name: "Hand to …" })).toBeVisible({
    timeout: 30_000,
  });
  await peek.getByRole("button", { name: "Hand to …" }).click();
  await peek.getByRole("button", { name: agent.name, exact: true }).click();
  await expect(peek.getByText(agent.name).first()).toBeVisible({
    timeout: 30_000,
  });

  await peek.getByRole("button", { name: "Hand to …" }).click();
  await peek.getByRole("button", { name: "Blair", exact: true }).click();
  await expect(peek.getByText("changed hands 1×")).toBeVisible({
    timeout: 30_000,
  });
  await expect(peek.getByText(agent.name).first()).toBeVisible();
  await expect(peek.getByText("Blair").first()).toBeVisible();

  const listed = await relayRpc<{
    conversations: { id: string; ticketId?: string }[];
  }>(page, stack, "conversations.list", { includeArchived: true });
  const hands = listed.conversations.filter((c) => c.ticketId === ticket.id);
  expect(hands).toHaveLength(2);
  expect(employee.name).toBe("Blair");
  await shot(page, "ac-2-hands");
});

test("a ticket waiting on another moves when that one is done", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await ready(page);
  const proj = await project();
  await startChat(
    page,
    stack.webUrl,
    agent,
    `surfaces: ticket ${proj.key} | Blocker`,
  );
  await expect(
    v3Peek(page).getByRole("button", { name: "Copy" }).first(),
  ).toBeVisible({ timeout: 90_000 });
  const blocker = await ticketNamed("Blocker");
  await startChat(
    page,
    stack.webUrl,
    agent,
    `surfaces: ticket ${proj.key} | After the blocker | ticket:${blocker.id} | owner:${agent.id}`,
  );
  await expect(
    v3Peek(page).getByRole("button", { name: "Copy" }).first(),
  ).toBeVisible({ timeout: 90_000 });

  await page.goto(`${stack.webUrl}/#?page=work&open=ticket:${blocker.id}`);
  await expect(main(page).getByText("Waiting on another ticket")).toBeVisible({
    timeout: 30_000,
  });
  const peek = v3Peek(page);
  await peek.getByRole("button", { name: "Mark done" }).click();
  await expect(main(page).getByText("Waiting on another ticket")).toHaveCount(
    0,
    { timeout: 30_000 },
  );
  await expect(main(page).getByText("Moving")).toBeVisible();
  await expect(main(page).getByText("After the blocker")).toBeVisible();

  await main(page)
    .getByRole("button", { name: /After the blocker/ })
    .click();
  await expect(
    v3Peek(page).getByText(`${blocker.id} is done, so this can move.`),
  ).toBeVisible({ timeout: 30_000 });
  await shot(page, "ac-3-moved");
});
