import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  openDefaultAgent,
  pickPorts,
  type Stack,
  startChat,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * Tickets are on (D-#776), so Work, Goals and Inbox are in the sidebar and
 * their links open those pages. There is still no CEO (that position is a
 * later slice): no "Ask the CEO", no "Make CEO", and ⌘K stays a search.
 */

let stack: Stack;
let agent: { id: string; name: string };
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("v3notickets", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.locator("#v3-main");
const palette = (page: Page) => page.getByRole("dialog", { name: "Search" });

test("the sidebar offers Work, Goals and Inbox, and a link opens that page", async ({
  page,
}) => {
  test.setTimeout(120_000);
  agent = await openDefaultAgent(page, stack.webUrl);
  const side = v3Sidebar(page);

  // What a company without tickets does have.
  for (const name of [
    "Search",
    "Home",
    "Needs you",
    "Threads",
    "Hire an agent",
    "How it works",
    "Settings",
  ])
    await expect(
      side.getByRole("button", { name: new RegExp(`^${name}`) }),
    ).toBeVisible();
  await expect(side.getByText("People", { exact: true })).toBeVisible();
  await expect(side.getByRole("button", { name: /Default/ })).toBeVisible();

  for (const name of ["Work", "Goals", "Inbox"])
    await expect(
      side.getByRole("button", { name: new RegExp(`^${name}`) }),
    ).toBeVisible();
  await expect(side.getByText("Projects", { exact: true })).toHaveCount(0);

  const links: [string, string][] = [
    ["#?page=work", "Work"],
    ["#?page=inbox", "Inbox"],
    ["#?page=goals", "Goals"],
  ];
  for (const [link, heading] of links) {
    await page.goto(`${stack.webUrl}/${link}`);
    await page.reload();
    await expect(main(page).getByRole("heading", { level: 1 })).toContainText(
      heading,
      { timeout: 30_000 },
    );
  }
  await page.goto(`${stack.webUrl}/#?page=work&open=ticket:HB-12`);
  await expect(v3Peek(page)).toContainText("Ticket not found.", {
    timeout: 30_000,
  });
  await page.goto(`${stack.webUrl}/#?page=goals&open=goal:g1`);
  await expect(v3Peek(page)).toContainText("Goal not found.", {
    timeout: 30_000,
  });
});

test("no CEO copy, and a person can be given a ticket", async ({ page }) => {
  test.setTimeout(180_000);
  await openDefaultAgent(page, stack.webUrl);
  await startChat(page, stack.webUrl, agent, "Say hello then list files");
  await expect(
    v3Peek(page).getByRole("button", { name: "Copy" }).first(),
  ).toBeVisible({ timeout: 60_000 });

  await page.goto(`${stack.webUrl}/#?page=home`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Good afternoon",
    { timeout: 30_000 },
  );
  const sections = main(page).getByRole("heading", { level: 3 });
  await expect(sections.filter({ hasText: "Goals" })).toBeVisible();
  await expect(main(page)).toContainText("Nothing needs you.");
  await expect(main(page).getByText("Ask the CEO")).toHaveCount(0);

  // Every page and view the sidebar leads to, plus a person's page and the
  // new-chat draft beside People: none of them carries the words.
  const pages: [string, string][] = [
    ["#?page=home", "Good afternoon"],
    ["#?page=needs", "Needs you"],
    ["#?page=threads", "Threads"],
    ["#?page=threads&view=all", "Threads"],
    ["#?page=threads&view=agent", "Threads"],
    ["#?page=threads&view=scheduled", "Threads"],
    ["#?page=people", "People"],
    ["#?page=people&view=org", "People"],
    ["#?page=settings&view=general", "Settings"],
    ["#?page=settings&view=engine", "Settings"],
    ["#?page=settings&view=phone", "Settings"],
    ["#?page=hire", "Hire an agent"],
    ["#?page=guide", "How the company works"],
    [`#?page=people&open=agent:${encodeURIComponent(agent.id)}`, "People"],
    [`#?page=people&open=newchat:${encodeURIComponent(agent.id)}`, "People"],
  ];
  for (const [link, heading] of pages) {
    await page.goto(`${stack.webUrl}/${link}`);
    await expect(main(page).getByRole("heading", { level: 1 })).toContainText(
      heading,
      { timeout: 30_000 },
    );
    if (link.includes("open=agent"))
      await expect(v3Peek(page).getByRole("heading", { level: 1 })).toHaveText(
        agent.name,
      );
    if (link.includes("open=newchat"))
      await expect(
        v3Peek(page).getByPlaceholder(`Message ${agent.name}…`),
      ).toBeVisible();
    await expect(page.getByText("Ask the CEO")).toHaveCount(0);
    await expect(page.getByText("Make CEO")).toHaveCount(0);
  }

  await page.goto(
    `${stack.webUrl}/#?page=people&open=agent:${encodeURIComponent(agent.id)}`,
  );
  await expect(
    v3Peek(page).getByRole("button", { name: "Message" }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    v3Peek(page).getByRole("button", { name: "Give a ticket" }),
  ).toBeVisible();
  await expect(
    v3Peek(page).getByRole("button", { name: "Make CEO" }),
  ).toHaveCount(0);

  await page.goto(`${stack.webUrl}/#?page=hire`);
  await expect(main(page).getByText("opens a PR for every ticket")).toBeVisible(
    {
      timeout: 30_000,
    },
  );
  await page.goto(`${stack.webUrl}/#?page=guide`);
  await expect(main(page).getByText("One piece of work")).toBeVisible({
    timeout: 30_000,
  });
});

test("⌘K searches and jumps; with no CEO behind it there is no draft to make", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openDefaultAgent(page, stack.webUrl);
  await page.goto(`${stack.webUrl}/#?page=home`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Good afternoon",
    { timeout: 30_000 },
  );

  // Search is the sidebar's one row (the top bar never repeats it, nor an
  // "Ask the CEO" box), and with no CEO to ask the palette says Search too.
  await expect(
    v3Sidebar(page).getByRole("button", { name: /^Search/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Search/ })).toHaveCount(1);
  await expect(page.getByText("Ask the CEO anything…")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette(page)).toBeVisible();
  const box = palette(page).getByRole("textbox");
  await expect(box).toHaveAttribute(
    "placeholder",
    "Search people, threads, projects…",
  );
  await expect(box).toBeFocused();

  await expect(
    palette(page).getByRole("button", { name: /^Needs you/ }),
  ).toBeVisible();
  await expect(
    palette(page).getByRole("button", { name: /^Threads/ }),
  ).toBeVisible();
  await expect(
    palette(page).getByRole("button", { name: /^Work/ }),
  ).toBeVisible();
  await expect(palette(page).getByText("Try", { exact: true })).toHaveCount(0);

  // Typed text that matches nothing is not a request to a CEO: Enter does
  // nothing, and no plan or answer ever appears.
  await box.fill("plan the product launch for next quarter");
  await expect(palette(page).getByRole("button")).toHaveCount(0);
  await expect(palette(page).getByText(/Ask the CEO/)).toHaveCount(0);
  await box.press("Enter");
  await expect(palette(page)).toBeVisible();
  await expect(
    palette(page).getByText(/CEO is reading|answered in/),
  ).toHaveCount(0);
  await expect(page).toHaveURL(/#?$|\/$/);

  // A person: searching the name jumps to them, beside the page you were on.
  await box.fill(agent.name.slice(0, 3));
  // Threads of theirs match the name too; the person is the row that is not
  // labelled a thread, and it comes first.
  const hit = palette(page)
    .getByRole("button", { name: new RegExp(agent.name) })
    .filter({ hasNotText: "thread" });
  await expect(hit).toHaveCount(1);
  await expect(palette(page).getByRole("button").first()).toHaveText(
    new RegExp(agent.name),
  );
  await box.press("Enter");
  await expect(palette(page)).toHaveCount(0);
  await expect(v3Peek(page).getByRole("heading", { level: 1 })).toHaveText(
    agent.name,
  );
  await expect(page).toHaveURL(/open=agent:/);
  await expect(page.getByRole("heading", { level: 1 }).first()).toContainText(
    "Good afternoon",
  );

  // A thread: found by its words, and Esc closes the palette without moving.
  await startChat(page, stack.webUrl, agent, "Say hello then list files");
  await expect(
    v3Peek(page).getByRole("button", { name: "Copy" }).first(),
  ).toBeVisible({ timeout: 60_000 });
  await page.goto(`${stack.webUrl}/#?page=home`);
  await page.keyboard.press("ControlOrMeta+k");
  await palette(page).getByRole("textbox").fill("hello");
  // Every earlier chat that said hello is a hit (this stack has run two).
  const threads = palette(page).getByRole("button", { name: /hello/i });
  await expect(threads.first()).toContainText("thread");
  await expect(threads).not.toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/open=/);
  await page.keyboard.press("ControlOrMeta+k");
  await palette(page).getByRole("textbox").fill("hello");
  await palette(page).getByRole("textbox").press("Enter");
  await expect(page).toHaveURL(/open=thread:conv_/);
  await expect(page.locator("[data-thread-panel]")).toBeVisible({
    timeout: 30_000,
  });
});
